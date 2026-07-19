'use strict'
Object.defineProperty(exports, '__esModule', { value: true })
exports.makeSocket = void 0
const boom_1 = require('@hapi/boom')
const crypto_1 = require('crypto')
const url_1 = require('url')
const util_1 = require('util')
const index_js_1 = require('../../WAProto/index.js')
const Defaults_1 = require('../Defaults')
const Types_1 = require('../Types')
const Utils_1 = require('../Utils')
const browser_utils_1 = require('../Utils/browser-utils')
const WABinary_1 = require('../WABinary')
const BinaryInfo_js_1 = require('../WAM/BinaryInfo.js')
const WAM_1 = require('../WAM')
const WAUSync_1 = require('../WAUSync/')
const Client_1 = require('./Client')
const mex_1 = require('./mex')
/**
 * Connects to WA servers and performs:
 * - simple queries (no retry mechanism, wait for connection establishment)
 * - listen to messages and emit events
 * - query phone connection
 */
const makeSocket = config => {
	const {
		waWebSocketUrl,
		connectTimeoutMs,
		logger,
		keepAliveIntervalMs,
		browser,
		auth: authState,
		printQRInTerminal,
		defaultQueryTimeoutMs,
		transactionOpts,
		qrTimeout,
		makeSignalRepository
	} = config
	const publicWAMBuffer = new BinaryInfo_js_1.BinaryInfo()
	let serverTimeOffsetMs = 0
	const uqTagId = (0, Utils_1.generateMdTagPrefix)()
	const generateMessageTag = () => `${uqTagId}${epoch++}`
	if (printQRInTerminal) {
		logger.warn(
			{},
			'⚠️ The printQRInTerminal option has been deprecated. You will no longer receive QR codes in the terminal automatically. Please listen to the connection.update event yourself and handle the QR your way. You can remove this message by removing this opttion. This message will be removed in a future version.'
		)
	}
	const syncDisabled =
		Defaults_1.PROCESSABLE_HISTORY_TYPES.map(syncType => config.shouldSyncHistoryMessage({ syncType })).filter(
			x => x === false
		).length === Defaults_1.PROCESSABLE_HISTORY_TYPES.length
	if (syncDisabled) {
		logger.warn(
			'⚠️ DANGER: DISABLING ALL SYNC BY shouldSyncHistoryMsg PREVENTS BAILEYS FROM ACCESSING INITIAL LID MAPPINGS, LEADING TO INSTABILIY AND SESSION ERRORS'
		)
	}
	const url = typeof waWebSocketUrl === 'string' ? new url_1.URL(waWebSocketUrl) : waWebSocketUrl
	if (config.mobile || url.protocol === 'tcp:') {
		throw new boom_1.Boom('Mobile API is not supported anymore', { statusCode: Types_1.DisconnectReason.loggedOut })
	}
	if (url.protocol === 'wss' && authState?.creds?.routingInfo) {
		url.searchParams.append('ED', authState.creds.routingInfo.toString('base64url'))
	}
	/** ephemeral key pair used to encrypt/decrypt communication. Unique for each connection */
	const ephemeralKeyPair = Utils_1.Curve.generateKeyPair()
	/** WA noise protocol wrapper */
	const noise = (0, Utils_1.makeNoiseHandler)({
		keyPair: ephemeralKeyPair,
		NOISE_HEADER: Defaults_1.NOISE_WA_HEADER,
		logger,
		routingInfo: authState?.creds?.routingInfo
	})
	const ws = new Client_1.WebSocketClient(url, config)
	const connectionStartTs = Date.now()
	ws.connect()
	const sendPromise = (0, util_1.promisify)(ws.send)
	/** send a raw buffer */
	const sendRawMessage = async data => {
		if (!ws.isOpen) {
			throw new boom_1.Boom('Connection Closed', { statusCode: Types_1.DisconnectReason.connectionClosed })
		}
		const bytes = noise.encodeFrame(data)
		await (0, Utils_1.promiseTimeout)(connectTimeoutMs, async (resolve, reject) => {
			try {
				await sendPromise.call(ws, bytes)
				resolve()
			} catch (error) {
				reject(error)
			}
		})
	}
	/** send a binary node */
	const sendNode = frame => {
		if (logger.level === 'trace') {
			logger.trace({ xml: (0, WABinary_1.binaryNodeToString)(frame), msg: 'xml send' })
		}
		const buff = (0, WABinary_1.encodeBinaryNode)(frame)
		return sendRawMessage(buff)
	}
	/**
	 * Wait for a message with a certain tag to be received
	 * @param msgId the message tag to await
	 * @param timeoutMs timeout after which the promise will reject
	 */
	const waitForMessage = async (msgId, timeoutMs = defaultQueryTimeoutMs) => {
		let onRecv
		let onErr
		try {
			const result = await (0, Utils_1.promiseTimeout)(timeoutMs, (resolve, reject) => {
				onRecv = data => {
					resolve(data)
				}
				onErr = err => {
					reject(
						err ||
							new boom_1.Boom('Connection Closed', {
								statusCode: Types_1.DisconnectReason.connectionClosed
							})
					)
				}
				ws.on(`TAG:${msgId}`, onRecv)
				ws.on('close', onErr)
				ws.on('error', onErr)
				return () => reject(new boom_1.Boom('Query Cancelled'))
			})
			return result
		} catch (error) {
			// Catch timeout and return undefined instead of throwing
			if (error instanceof boom_1.Boom && error.output?.statusCode === Types_1.DisconnectReason.timedOut) {
				logger?.warn?.({ msgId }, 'timed out waiting for message')
				return undefined
			}
			throw error
		} finally {
			if (onRecv) ws.off(`TAG:${msgId}`, onRecv)
			if (onErr) {
				ws.off('close', onErr)
				ws.off('error', onErr)
			}
		}
	}
	/** send a query, and wait for its response. auto-generates message ID if not provided */
	const query = async (node, timeoutMs) => {
		if (!node.attrs.id) {
			node.attrs.id = generateMessageTag()
		}
		const msgId = node.attrs.id
		const result = await (0, Utils_1.promiseTimeout)(timeoutMs, async (resolve, reject) => {
			const result = waitForMessage(msgId, timeoutMs).catch(reject)
			sendNode(node)
				.then(async () => resolve(await result))
				.catch(reject)
		})
		if (result && 'tag' in result) {
			;(0, WABinary_1.assertNodeErrorFree)(result)
		}
		return result
	}
	// Validate current key-bundle on server; on failure, trigger pre-key upload and rethrow
	const digestKeyBundle = async () => {
		const res = await query({
			tag: 'iq',
			attrs: { to: WABinary_1.S_WHATSAPP_NET, type: 'get', xmlns: 'encrypt' },
			content: [{ tag: 'digest', attrs: {} }]
		})
		const digestNode = (0, WABinary_1.getBinaryNodeChild)(res, 'digest')
		if (!digestNode) {
			await uploadPreKeys()
			throw new Error('encrypt/get digest returned no digest node')
		}
	}
	// Rotate our signed pre-key on server; on failure, run digest as fallback and rethrow
	const rotateSignedPreKey = async () => {
		const newId = (creds.signedPreKey.keyId || 0) + 1
		const skey = await (0, Utils_1.signedKeyPair)(creds.signedIdentityKey, newId)
		await query({
			tag: 'iq',
			attrs: { to: WABinary_1.S_WHATSAPP_NET, type: 'set', xmlns: 'encrypt' },
			content: [
				{
					tag: 'rotate',
					attrs: {},
					content: [(0, Utils_1.xmppSignedPreKey)(skey)]
				}
			]
		})
		// Persist new signed pre-key in creds
		ev.emit('creds.update', { signedPreKey: skey })
	}
	const executeUSyncQuery = async usyncQuery => {
		if (usyncQuery.protocols.length === 0) {
			throw new boom_1.Boom('USyncQuery must have at least one protocol')
		}
		const validUsers = usyncQuery.users.filter(user => (typeof user.validate === 'function' ? user.validate() : true))
		if (!validUsers.length) {
			logger.warn('a usync query must have at least one valid user')
		}
		const userNodes = validUsers.map(user => {
			return {
				tag: 'user',
				attrs: {
					jid: !user.phone ? user.id : undefined,
					pn_jid: user.pnJid
				},
				content: usyncQuery.protocols.map(a => a.getUserElement(user)).filter(a => a !== null)
			}
		})
		const listNode = {
			tag: 'list',
			attrs: {},
			content: userNodes
		}
		const queryNode = {
			tag: 'query',
			attrs: {},
			content: usyncQuery.protocols.map(a => a.getQueryElement())
		}
		const iq = {
			tag: 'iq',
			attrs: {
				to: WABinary_1.S_WHATSAPP_NET,
				type: 'get',
				xmlns: 'usync'
			},
			content: [
				{
					tag: 'usync',
					attrs: {
						context: usyncQuery.context,
						mode: usyncQuery.mode,
						sid: generateMessageTag(),
						last: 'true',
						index: '0'
					},
					content: [queryNode, listNode]
				}
			]
		}
		await (0, WAUSync_1.waitForBackoff)(usyncQuery)
		const result = await query(iq)
		const parsed = usyncQuery.parseUSyncQueryResult(result)
		if (parsed?.errors) {
			for (const [protocolName, err] of Object.entries(parsed.errors)) {
				if (err?.errorBackoff) {
					;(0, WAUSync_1.setProtocolBackoffMs)(protocolName, err.errorBackoff * 1000)
				}
			}
		}
		return parsed
	}
	const onWhatsApp = async (...phoneNumber) => {
		let usyncQuery = new WAUSync_1.USyncQuery()
		let contactEnabled = false
		for (const jid of phoneNumber) {
			if ((0, WABinary_1.isLidUser)(jid)) {
				logger?.warn('LIDs are not supported with onWhatsApp')
				continue
			} else {
				if (!contactEnabled) {
					contactEnabled = true
					usyncQuery = usyncQuery.withContactProtocol()
				}
				const phone = `+${jid.replace('+', '').split('@')[0]?.split(':')[0]}`
				usyncQuery.withUser(new WAUSync_1.USyncUser().withPhone(phone))
			}
		}
		if (usyncQuery.users.length === 0) {
			return [] // return early without forcing an empty query
		}
		const results = await executeUSyncQuery(usyncQuery)
		if (results) {
			return results.list.filter(a => !!a.contact).map(({ contact, id }) => ({ jid: id, exists: contact }))
		}
	}
	const pnFromLIDUSync = async jids => {
		const usyncQuery = new WAUSync_1.USyncQuery().withLIDProtocol().withContext('background')
		for (const jid of jids) {
			if ((0, WABinary_1.isLidUser)(jid)) {
				logger?.warn('LID user found in LID fetch call')
				continue
			} else {
				usyncQuery.withUser(new WAUSync_1.USyncUser().withId(jid))
			}
		}
		if (usyncQuery.users.length === 0) {
			return [] // return early without forcing an empty query
		}
		const results = await executeUSyncQuery(usyncQuery)
		if (results) {
			return results.list.filter(a => !!a.lid).map(({ lid, id }) => ({ pn: id, lid: lid }))
		}
		return []
	}
	const ev = (0, Utils_1.makeEventBuffer)(logger)
	const { creds } = authState
	// add transaction capability
	const keys = (0, Utils_1.addTransactionCapability)(authState.keys, logger, transactionOpts)
	const signalRepository = makeSignalRepository({ creds, keys }, logger, pnFromLIDUSync)
	let lastDateRecv
	let epoch = 1
	let keepAliveReq
	let qrTimer
	let closed = false
	/** log & process any unexpected errors */
	const onUnexpectedError = (err, msg) => {
		logger.error({ err }, `unexpected error in '${msg}'`)
	}
	/** await the next incoming message */
	const awaitNextMessage = async sendMsg => {
		if (!ws.isOpen) {
			throw new boom_1.Boom('Connection Closed', {
				statusCode: Types_1.DisconnectReason.connectionClosed
			})
		}
		let onOpen
		let onClose
		const result = (0, Utils_1.promiseTimeout)(connectTimeoutMs, (resolve, reject) => {
			onOpen = resolve
			onClose = mapWebSocketError(reject)
			ws.on('frame', onOpen)
			ws.on('close', onClose)
			ws.on('error', onClose)
		}).finally(() => {
			ws.off('frame', onOpen)
			ws.off('close', onClose)
			ws.off('error', onClose)
		})
		if (sendMsg) {
			sendRawMessage(sendMsg).catch(onClose)
		}
		return result
	}
	/** connection handshake */
	const validateConnection = async () => {
		let helloMsg = {
			clientHello: { ephemeral: ephemeralKeyPair.public }
		}
		helloMsg = index_js_1.proto.HandshakeMessage.fromObject(helloMsg)
		logger.info({ browser, helloMsg }, 'connected to WA')
		const init = index_js_1.proto.HandshakeMessage.encode(helloMsg).finish()
		const result = await awaitNextMessage(init)
		const handshake = index_js_1.proto.HandshakeMessage.decode(result)
		logger.trace({ handshake }, 'handshake recv from WA')
		const { keyEnc, serverStaticPub } = noise.processHandshake(handshake, creds.noiseKey)
		let node
		if (!creds.me) {
			node = (0, Utils_1.generateRegistrationNode)(creds, config)
			logger.info({ node }, 'not logged in, attempting registration...')
		} else {
			node = (0, Utils_1.generateLoginNode)(creds.me.id, config, creds)
			logger.info({ node }, 'logging in...')
		}
		const payloadEnc = noise.encrypt(index_js_1.proto.ClientPayload.encode(node).finish())
		await sendRawMessage(
			index_js_1.proto.HandshakeMessage.encode({
				clientFinish: {
					static: keyEnc,
					payload: payloadEnc
				}
			}).finish()
		)
		await noise.finishInit()
		if (serverStaticPub && !creds.serverStaticPub) {
			ev.emit('creds.update', { serverStaticPub })
		}
		startKeepAliveRequest()
	}
	const getAvailablePreKeysOnServer = async () => {
		const result = await query({
			tag: 'iq',
			attrs: {
				id: generateMessageTag(),
				xmlns: 'encrypt',
				type: 'get',
				to: WABinary_1.S_WHATSAPP_NET
			},
			content: [{ tag: 'count', attrs: {} }]
		})
		const countChild = (0, WABinary_1.getBinaryNodeChild)(result, 'count')
		return +countChild.attrs.value
	}
	// Pre-key upload state management
	let uploadPreKeysPromise = null
	let lastUploadTime = 0
	/** generates and uploads a set of pre-keys to the server */
	const uploadPreKeys = async (count = Defaults_1.MIN_PREKEY_COUNT, retryCount = 0) => {
		// Check minimum interval (except for retries)
		if (retryCount === 0) {
			const timeSinceLastUpload = Date.now() - lastUploadTime
			if (timeSinceLastUpload < Defaults_1.MIN_UPLOAD_INTERVAL) {
				logger.debug(`Skipping upload, only ${timeSinceLastUpload}ms since last upload`)
				return
			}
		}
		// Prevent multiple concurrent uploads
		if (uploadPreKeysPromise) {
			logger.debug('Pre-key upload already in progress, waiting for completion')
			await uploadPreKeysPromise
		}
		const uploadLogic = async () => {
			logger.info({ count, retryCount }, 'uploading pre-keys')
			// Generate and save pre-keys atomically (prevents ID collisions on retry)
			const node = await keys.transaction(async () => {
				logger.debug({ requestedCount: count }, 'generating pre-keys with requested count')
				const { update, node } = await (0, Utils_1.getNextPreKeysNode)({ creds, keys }, count)
				// Update credentials immediately to prevent duplicate IDs on retry
				ev.emit('creds.update', update)
				return node // Only return node since update is already used
			}, creds?.me?.id || 'upload-pre-keys')
			// Upload to server (outside transaction, can fail without affecting local keys)
			try {
				await query(node)
				logger.info({ count }, 'uploaded pre-keys successfully')
				lastUploadTime = Date.now()
			} catch (uploadError) {
				logger.error({ uploadError: uploadError.toString(), count }, 'Failed to upload pre-keys to server')
				// Exponential backoff retry (max 3 retries)
				if (retryCount < 3) {
					const backoffDelay = Math.min(1000 * Math.pow(2, retryCount), 10000)
					logger.info(`Retrying pre-key upload in ${backoffDelay}ms`)
					await new Promise(resolve => setTimeout(resolve, backoffDelay))
					return uploadPreKeys(count, retryCount + 1)
				}
				throw uploadError
			}
		}
		// Add timeout protection
		uploadPreKeysPromise = Promise.race([
			uploadLogic(),
			new Promise((_, reject) =>
				setTimeout(
					() => reject(new boom_1.Boom('Pre-key upload timeout', { statusCode: 408 })),
					Defaults_1.UPLOAD_TIMEOUT
				)
			)
		])
		try {
			await uploadPreKeysPromise
		} finally {
			uploadPreKeysPromise = null
		}
	}
	const verifyCurrentPreKeyExists = async () => {
		const currentPreKeyId = creds.nextPreKeyId - 1
		if (currentPreKeyId <= 0) {
			return { exists: false, currentPreKeyId: 0 }
		}
		const preKeys = await keys.get('pre-key', [currentPreKeyId.toString()])
		const exists = !!preKeys[currentPreKeyId.toString()]
		return { exists, currentPreKeyId }
	}
	const uploadPreKeysToServerIfRequired = async () => {
		try {
			let count = 0
			const preKeyCount = await getAvailablePreKeysOnServer()
			if (preKeyCount === 0) count = Defaults_1.INITIAL_PREKEY_COUNT
			else count = Defaults_1.MIN_PREKEY_COUNT
			const { exists: currentPreKeyExists, currentPreKeyId } = await verifyCurrentPreKeyExists()
			logger.info(`${preKeyCount} pre-keys found on server`)
			logger.info(`Current prekey ID: ${currentPreKeyId}, exists in storage: ${currentPreKeyExists}`)
			const lowServerCount = preKeyCount <= count
			const missingCurrentPreKey = !currentPreKeyExists && currentPreKeyId > 0
			const shouldUpload = lowServerCount || missingCurrentPreKey
			if (shouldUpload) {
				const reasons = []
				if (lowServerCount) reasons.push(`server count low (${preKeyCount})`)
				if (missingCurrentPreKey) reasons.push(`current prekey ${currentPreKeyId} missing from storage`)
				logger.info(`Uploading PreKeys due to: ${reasons.join(', ')}`)
				await uploadPreKeys(count)
			} else {
				logger.info(`PreKey validation passed - Server: ${preKeyCount}, Current prekey ${currentPreKeyId} exists`)
			}
		} catch (error) {
			logger.error({ error }, 'Failed to check/upload pre-keys during initialization')
			// Don't throw - allow connection to continue even if pre-key check fails
		}
	}
	const onMessageReceived = async data => {
		await noise.decodeFrame(data, frame => {
			// reset ping timeout
			lastDateRecv = new Date()
			let anyTriggered = false
			anyTriggered = ws.emit('frame', frame)
			// if it's a binary node
			if (!(frame instanceof Uint8Array)) {
				const msgId = frame.attrs.id
				if (logger.level === 'trace') {
					logger.trace({ xml: (0, WABinary_1.binaryNodeToString)(frame), msg: 'recv xml' })
				}
				/* Check if this is a response to a message we sent */
				anyTriggered = ws.emit(`${Defaults_1.DEF_TAG_PREFIX}${msgId}`, frame) || anyTriggered
				/* Check if this is a response to a message we are expecting */
				const l0 = frame.tag
				const l1 = frame.attrs || {}
				const l2 = Array.isArray(frame.content) ? frame.content[0]?.tag : ''
				for (const key of Object.keys(l1)) {
					anyTriggered =
						ws.emit(`${Defaults_1.DEF_CALLBACK_PREFIX}${l0},${key}:${l1[key]},${l2}`, frame) || anyTriggered
					anyTriggered = ws.emit(`${Defaults_1.DEF_CALLBACK_PREFIX}${l0},${key}:${l1[key]}`, frame) || anyTriggered
					anyTriggered = ws.emit(`${Defaults_1.DEF_CALLBACK_PREFIX}${l0},${key}`, frame) || anyTriggered
				}
				anyTriggered = ws.emit(`${Defaults_1.DEF_CALLBACK_PREFIX}${l0},,${l2}`, frame) || anyTriggered
				anyTriggered = ws.emit(`${Defaults_1.DEF_CALLBACK_PREFIX}${l0}`, frame) || anyTriggered
				if (!anyTriggered && logger.level === 'debug') {
					logger.debug({ unhandled: true, msgId, fromMe: false, frame }, 'communication recv')
				}
			}
		})
	}
	const end = async error => {
		if (closed) {
			logger.trace({ trace: error?.stack }, 'connection already closed')
			return
		}
		closed = true
		logger.info({ trace: error?.stack }, error ? 'connection errored' : 'connection closed')
		clearInterval(keepAliveReq)
		clearInterval(wamFlushInterval)
		clearTimeout(qrTimer)
		ws.removeAllListeners('close')
		ws.removeAllListeners('open')
		ws.removeAllListeners('message')
		if (!ws.isClosed && !ws.isClosing) {
			try {
				await ws.close()
			} catch {}
		}
		ev.emit('connection.update', {
			connection: 'close',
			lastDisconnect: {
				error,
				date: new Date()
			}
		})
		ev.removeAllListeners('connection.update')
	}
	const waitForSocketOpen = async () => {
		if (ws.isOpen) {
			return
		}
		if (ws.isClosed || ws.isClosing) {
			throw new boom_1.Boom('Connection Closed', { statusCode: Types_1.DisconnectReason.connectionClosed })
		}
		let onOpen
		let onClose
		await new Promise((resolve, reject) => {
			onOpen = () => resolve(undefined)
			onClose = mapWebSocketError(reject)
			ws.on('open', onOpen)
			ws.on('close', onClose)
			ws.on('error', onClose)
		}).finally(() => {
			ws.off('open', onOpen)
			ws.off('close', onClose)
			ws.off('error', onClose)
		})
	}
	const startKeepAliveRequest = () =>
		(keepAliveReq = setInterval(() => {
			if (!lastDateRecv) {
				lastDateRecv = new Date()
			}
			const diff = Date.now() - lastDateRecv.getTime()
			/*
            check if it's been a suspicious amount of time since the server responded with our last seen
            it could be that the network is down
        */
			if (diff > keepAliveIntervalMs + 5000) {
				void end(new boom_1.Boom('Connection was lost', { statusCode: Types_1.DisconnectReason.connectionLost }))
			} else if (ws.isOpen) {
				// if its all good, send a keep alive request
				// Confirmed from live capture: the w:p keepalive iq has no child element
				// at all — a bare <ping/> child doesn't appear in real traffic.
				query({
					tag: 'iq',
					attrs: {
						id: generateMessageTag(),
						to: WABinary_1.S_WHATSAPP_NET,
						type: 'get',
						xmlns: 'w:p'
					}
				}).catch(err => {
					logger.error({ trace: err.stack }, 'error in sending keep alive')
				})
			} else {
				logger.warn('keep alive called when WS not open')
			}
		}, keepAliveIntervalMs))
	/** i have no idea why this exists. pls enlighten me */
	const sendPassiveIq = tag =>
		query({
			tag: 'iq',
			attrs: {
				to: WABinary_1.S_WHATSAPP_NET,
				xmlns: 'passive',
				type: 'set'
			},
			content: [{ tag, attrs: {} }]
		})
	/** logout & invalidate connection */
	const logout = async msg => {
		const jid = authState.creds.me?.id
		if (jid) {
			await sendNode({
				tag: 'iq',
				attrs: {
					to: WABinary_1.S_WHATSAPP_NET,
					type: 'set',
					id: generateMessageTag(),
					xmlns: 'md'
				},
				content: [
					{
						tag: 'remove-companion-device',
						attrs: {
							jid,
							reason: 'user_initiated'
						}
					}
				]
			})
		}
		void end(new boom_1.Boom(msg || 'Intentional Logout', { statusCode: Types_1.DisconnectReason.loggedOut }))
	}
	const requestPairingCode = async (phoneNumber, customPairingCode) => {
		const pairingCode = customPairingCode ?? (0, Utils_1.bytesToCrockford)((0, crypto_1.randomBytes)(5))
		if (customPairingCode && customPairingCode.length !== 8) {
			throw new Error('Custom pairing code must be exactly 8 chars')
		}
		authState.creds.pairingCode = pairingCode
		authState.creds.me = {
			id: (0, WABinary_1.jidEncode)(phoneNumber, 's.whatsapp.net'),
			name: '~'
		}
		ev.emit('creds.update', authState.creds)
		await sendNode({
			tag: 'iq',
			attrs: {
				to: WABinary_1.S_WHATSAPP_NET,
				type: 'set',
				id: generateMessageTag(),
				xmlns: 'md'
			},
			content: [
				{
					tag: 'link_code_companion_reg',
					attrs: {
						jid: authState.creds.me.id,
						stage: 'companion_hello',
						should_show_push_notification: 'true'
					},
					content: [
						{
							tag: 'link_code_pairing_wrapped_companion_ephemeral_pub',
							attrs: {},
							content: await generatePairingKey()
						},
						{
							tag: 'companion_server_auth_key_pub',
							attrs: {},
							content: authState.creds.noiseKey.public
						},
						{
							tag: 'companion_platform_id',
							attrs: {},
							content: (0, browser_utils_1.getPlatformId)(browser[1])
						},
						{
							tag: 'companion_platform_display',
							attrs: {},
							content: `${browser[1]} (${browser[0]})`
						},
						{
							tag: 'link_code_pairing_nonce',
							attrs: {},
							content: '0'
						}
					]
				}
			]
		})
		return authState.creds.pairingCode
	}
	async function generatePairingKey() {
		const salt = (0, crypto_1.randomBytes)(32)
		const randomIv = (0, crypto_1.randomBytes)(16)
		const key = await (0, Utils_1.derivePairingCodeKey)(authState.creds.pairingCode, salt)
		const ciphered = (0, Utils_1.aesEncryptCTR)(authState.creds.pairingEphemeralKeyPair.public, key, randomIv)
		return Buffer.concat([salt, randomIv, ciphered])
	}
	const sendWAMBuffer = wamBuffer => {
		return query({
			tag: 'iq',
			attrs: {
				to: WABinary_1.S_WHATSAPP_NET,
				id: generateMessageTag(),
				xmlns: 'w:stats',
				type: 'set'
			},
			content: [
				{
					tag: 'add',
					attrs: { t: Math.round(Date.now() / 1000) + '' },
					content: wamBuffer
				}
			]
		})
	}
	const flushWAMEvents = async () => {
		if (!publicWAMBuffer.events.length) return
		try {
			const encoded = (0, WAM_1.encodeWAM)(publicWAMBuffer)
			publicWAMBuffer.events = []
			publicWAMBuffer.sequence = (publicWAMBuffer.sequence + 1) & 0xffff
			await sendWAMBuffer(encoded)
		} catch (e) {
			logger.debug({ err: e }, 'WAM flush failed')
		}
	}
	const wsOpenTs = { value: connectionStartTs }
	ws.on('message', onMessageReceived)
	ws.on('open', async () => {
		wsOpenTs.value = Date.now()
		publicWAMBuffer.events.push({
			WebcSocketConnect: {
				props: {
					webcSocketConnectDuration: wsOpenTs.value - connectionStartTs,
					webcSocketConnectReason: 0
				},
				globals: {}
			}
		})
		try {
			await validateConnection()
		} catch (err) {
			logger.error({ err }, 'error in validating connection')
			void end(err)
		}
	})
	const wamFlushInterval = setInterval(() => {
		void flushWAMEvents()
	}, 30_000)
	ws.on('error', mapWebSocketError(end))
	ws.on(
		'close',
		() => void end(new boom_1.Boom('Connection Terminated', { statusCode: Types_1.DisconnectReason.connectionClosed }))
	)
	// the server terminated the connection
	ws.on(
		'CB:xmlstreamend',
		() =>
			void end(
				new boom_1.Boom('Connection Terminated by Server', { statusCode: Types_1.DisconnectReason.connectionClosed })
			)
	)
	// QR gen
	ws.on('CB:iq,type:set,pair-device', async stanza => {
		const iq = {
			tag: 'iq',
			attrs: {
				to: WABinary_1.S_WHATSAPP_NET,
				type: 'result',
				id: stanza.attrs.id
			}
		}
		await sendNode(iq)
		const pairDeviceNode = (0, WABinary_1.getBinaryNodeChild)(stanza, 'pair-device')
		const refNodes = (0, WABinary_1.getBinaryNodeChildren)(pairDeviceNode, 'ref')
		const noiseKeyB64 = Buffer.from(creds.noiseKey.public).toString('base64')
		const identityKeyB64 = Buffer.from(creds.signedIdentityKey.public).toString('base64')
		const advB64 = creds.advSecretKey
		let qrMs = qrTimeout || 60000 // time to let a QR live
		const genPairQR = () => {
			if (!ws.isOpen) {
				return
			}
			const refNode = refNodes.shift()
			if (!refNode) {
				void end(new boom_1.Boom('QR refs attempts ended', { statusCode: Types_1.DisconnectReason.timedOut }))
				return
			}
			const ref = refNode.content.toString('utf8')
			const qr = [ref, noiseKeyB64, identityKeyB64, advB64].join(',')
			ev.emit('connection.update', { qr })
			qrTimer = setTimeout(genPairQR, qrMs)
			qrMs = qrTimeout || 20000 // shorter subsequent qrs
		}
		genPairQR()
	})
	// device paired for the first time
	// if device pairs successfully, the server asks to restart the connection
	ws.on('CB:iq,,pair-success', async stanza => {
		logger.debug('pair success recv')
		try {
			updateServerTimeOffset(stanza)
			const { reply, creds: updatedCreds } = (0, Utils_1.configureSuccessfulPairing)(stanza, creds)
			logger.info(
				{ me: updatedCreds.me, platform: updatedCreds.platform },
				'pairing configured successfully, expect to restart the connection...'
			)
			ev.emit('creds.update', updatedCreds)
			ev.emit('connection.update', { isNewLogin: true, qr: undefined })
			await sendNode(reply)
			void sendUnifiedSession()
		} catch (error) {
			logger.info({ trace: error.stack }, 'error in pairing')
			void end(error)
		}
	})
	// login complete
	ws.on('CB:success', async node => {
		try {
			updateServerTimeOffset(node)
			await uploadPreKeysToServerIfRequired()
			// passive→active handshake only for companion (passive) sessions
			if (!config.masqueradeAsPrimary) {
				await sendPassiveIq('active')
			}
			// After successful login, validate our key-bundle against server
			try {
				await digestKeyBundle()
			} catch (e) {
				logger.warn({ e }, 'failed to run digest after login')
			}
		} catch (err) {
			logger.warn({ err }, 'failed to send initial passive iq')
		}
		logger.info('opened connection to WA')
		clearTimeout(qrTimer) // will never happen in all likelyhood -- but just in case WA sends success on first try
		// Fire Login WAM event
		publicWAMBuffer.events.push({
			Login: {
				props: { loginResult: 1, loginT: Date.now() - connectionStartTs, connectionOrigin: 1, passive: false },
				globals: {}
			}
		})
		void flushWAMEvents()
		ev.emit('creds.update', { me: { ...authState.creds.me, lid: node.attrs.lid } })
		if (config.syncFullHistory && authState.creds.initialFullSyncDone !== true) {
			logger.debug('initial full history sync completed, persisting one-time flag')
			ev.emit('creds.update', { initialFullSyncDone: true })
		}
		ev.emit('connection.update', { connection: 'open' })
		void sendUnifiedSession()
		if (node.attrs.lid && authState.creds.me?.id) {
			const myLID = node.attrs.lid
			process.nextTick(async () => {
				try {
					const myPN = authState.creds.me.id
					// Store our own LID-PN mapping
					await signalRepository.lidMapping.storeLIDPNMappings([{ lid: myLID, pn: myPN }])
					// Create device list for our own user (needed for bulk migration)
					const { user, device } = (0, WABinary_1.jidDecode)(myPN)
					await authState.keys.set({
						'device-list': {
							[user]: [device?.toString() || '0']
						}
					})
					// migrate our own session
					await signalRepository.migrateSession(myPN, myLID)
					logger.info({ myPN, myLID }, 'Own LID session created successfully')
				} catch (error) {
					logger.error({ error, lid: myLID }, 'Failed to create own LID session')
				}
			})
		}
	})
	ws.on('CB:stream:error', node => {
		const [reasonNode] = (0, WABinary_1.getAllBinaryNodeChildren)(node)
		logger.error({ reasonNode, fullErrorNode: node }, 'stream errored out')
		const { reason, statusCode } = (0, Utils_1.getErrorCodeFromStreamError)(node)
		void end(new boom_1.Boom(`Stream Errored (${reason})`, { statusCode, data: reasonNode || node }))
	})
	// stream fail, possible logout
	ws.on('CB:failure', node => {
		const reason = +(node.attrs.reason || 500)
		void end(new boom_1.Boom('Connection Failure', { statusCode: reason, data: node.attrs }))
	})
	ws.on('CB:ib,,downgrade_webclient', () => {
		void end(
			new boom_1.Boom('Multi-device beta not joined', { statusCode: Types_1.DisconnectReason.multideviceMismatch })
		)
	})
	ws.on('CB:ib,,dirty', node => {
		const dirtyNode = (0, WABinary_1.getBinaryNodeChild)(node, 'dirty')
		const dirtyType = dirtyNode?.attrs?.type
		const dirtyTs = dirtyNode?.attrs?.timestamp ? +dirtyNode.attrs.timestamp : undefined
		// dirty signals that server-side account data changed; a notification with the same
		// type will follow immediately — no response stanza required
		logger.debug({ dirtyType, dirtyTs }, 'received dirty flag')
		ev.emit('account.dirty', { type: dirtyType, timestamp: dirtyTs })
	})
	ws.on('CB:ib,,offline_preview', async node => {
		logger.info('offline preview received', JSON.stringify(node))
		await sendNode({
			tag: 'ib',
			attrs: {},
			content: [{ tag: 'offline_batch', attrs: { count: '100' } }]
		})
	})
	ws.on('CB:ib,,thread_metadata', node => {
		const tmNode = (0, WABinary_1.getBinaryNodeChild)(node, 'thread_metadata')
		const items = (0, WABinary_1.getBinaryNodeChildren)(tmNode, 'item')
		if (items.length) {
			ev.emit(
				'thread-metadata.update',
				items.map(item => ({
					jid: item.attrs.from,
					t: item.attrs.t ? +item.attrs.t : undefined
				}))
			)
		}
	})
	ws.on('CB:ib,,edge_routing', node => {
		const edgeRoutingNode = (0, WABinary_1.getBinaryNodeChild)(node, 'edge_routing')
		const routingInfo = (0, WABinary_1.getBinaryNodeChild)(edgeRoutingNode, 'routing_info')
		if (routingInfo?.content) {
			authState.creds.routingInfo = Buffer.from(routingInfo?.content)
			ev.emit('creds.update', authState.creds)
		}
	})
	let didStartBuffer = false
	process.nextTick(() => {
		if (creds.me?.id) {
			// start buffering important events
			// if we're logged in
			ev.buffer()
			didStartBuffer = true
		}
		ev.emit('connection.update', { connection: 'connecting', receivedPendingNotifications: false, qr: undefined })
	})
	// called when all offline notifs are handled
	ws.on('CB:ib,,offline', node => {
		const child = (0, WABinary_1.getBinaryNodeChild)(node, 'offline')
		const offlineNotifs = +(child?.attrs.count || 0)
		logger.info(`handled ${offlineNotifs} offline messages/notifications`)
		if (didStartBuffer) {
			ev.flush()
			logger.trace('flushed events for initial buffer')
		}
		ev.emit('connection.update', { receivedPendingNotifications: true })
	})
	// update credentials when required
	ev.on('creds.update', update => {
		const name = update.me?.name
		// if name has just been received
		if (creds.me?.name !== name) {
			logger.debug({ name }, 'updated pushName')
			sendNode({
				tag: 'presence',
				attrs: { name: name }
			}).catch(err => {
				logger.warn({ trace: err.stack }, 'error in sending presence update on name change')
			})
		}
		Object.assign(creds, update)
	})
	const updateServerTimeOffset = ({ attrs }) => {
		const tValue = attrs?.t
		if (!tValue) {
			return
		}
		const parsed = Number(tValue)
		if (Number.isNaN(parsed) || parsed <= 0) {
			return
		}
		const localMs = Date.now()
		serverTimeOffsetMs = parsed * 1000 - localMs
		logger.debug({ offset: serverTimeOffsetMs }, 'calculated server time offset')
	}
	const getUnifiedSessionId = () => {
		const offsetMs = 3 * Defaults_1.TimeMs.Day
		const now = Date.now() + serverTimeOffsetMs
		const id = (now + offsetMs) % Defaults_1.TimeMs.Week
		return id.toString()
	}
	const sendUnifiedSession = async () => {
		if (!ws.isOpen) {
			return
		}
		const node = {
			tag: 'ib',
			attrs: {},
			content: [
				{
					tag: 'unified_session',
					attrs: {
						id: getUnifiedSessionId()
					}
				}
			]
		}
		try {
			await sendNode(node)
		} catch (error) {
			logger.debug({ error }, 'failed to send unified_session telemetry')
		}
	}
	const fetchAccountReachoutTimelock = async () => {
		const queryResult = await (0, mex_1.executeWMexQuery)(
			{},
			Types_1.QueryIds.REACHOUT_TIMELOCK,
			Types_1.XWAPaths.xwa2_fetch_account_reachout_timelock,
			query,
			generateMessageTag
		)
		const result = {
			isActive: !!queryResult?.is_active,
			timeEnforcementEnds:
				queryResult?.time_enforcement_ends && queryResult?.time_enforcement_ends !== '0'
					? new Date(parseInt(queryResult.time_enforcement_ends, 10) * 1000)
					: undefined,
			enforcementType: queryResult?.enforcement_type ?? Types_1.ReachoutTimelockEnforcementType.DEFAULT
		}
		ev.emit('connection.update', { reachoutTimeLock: result })
		return result
	}
	const fetchNewChatMessageCap = async () => {
		return (0, mex_1.executeWMexQuery)(
			{ input: { type: 'INDIVIDUAL_NEW_CHAT_MSG' } },
			Types_1.QueryIds.MESSAGE_CAPPING_INFO,
			Types_1.XWAPaths.xwa2_message_capping_info,
			query,
			generateMessageTag
		)
	}
	return {
		type: 'md',
		ws,
		ev,
		authState: { creds, keys },
		signalRepository,
		get user() {
			return authState.creds.me
		},
		generateMessageTag,
		query,
		waitForMessage,
		waitForSocketOpen,
		sendRawMessage,
		sendNode,
		logout,
		end,
		onUnexpectedError,
		uploadPreKeys,
		uploadPreKeysToServerIfRequired,
		digestKeyBundle,
		rotateSignedPreKey,
		requestPairingCode,
		updateServerTimeOffset,
		sendUnifiedSession,
		wamBuffer: publicWAMBuffer,
		/** Waits for the connection to WA to reach a state */
		waitForConnectionUpdate: (0, Utils_1.bindWaitForConnectionUpdate)(ev),
		sendWAMBuffer,
		executeUSyncQuery,
		onWhatsApp,
		fetchAccountReachoutTimelock,
		fetchNewChatMessageCap,
		logger,
		masqueradeAsPrimary: config.masqueradeAsPrimary
	}
}
exports.makeSocket = makeSocket
/**
 * map the websocket error to the right type
 * so it can be retried by the caller
 * */
function mapWebSocketError(handler) {
	return error => {
		handler(
			new boom_1.Boom(`WebSocket Error (${error?.message})`, {
				statusCode: (0, Utils_1.getCodeFromWSError)(error),
				data: error
			})
		)
	}
}
