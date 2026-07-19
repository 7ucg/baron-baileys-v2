'use strict'
Object.defineProperty(exports, '__esModule', { value: true })
exports.isWABusinessPlatform =
	exports.getCodeFromWSError =
	exports.getCallStatusFromNode =
	exports.getErrorCodeFromStreamError =
	exports.getStatusFromReceiptType =
	exports.generateMdTagPrefix =
	exports.fetchLatestWaWebVersion =
	exports.fetchLatestBaileysVersion =
	exports.bindWaitForConnectionUpdate =
	exports.generateMessageID =
	exports.generateMessageIDV2 =
	exports.delayCancellable =
	exports.delay =
	exports.debouncedTimeout =
	exports.unixTimestampSeconds =
	exports.toNumber =
	exports.encodeBigEndian =
	exports.generateRegistrationId =
	exports.encodeWAMessage =
	exports.generateParticipantHashV2 =
	exports.unpadRandomMax16 =
	exports.writeRandomPadMax16 =
	exports.isStringNullOrEmpty =
	exports.getKeyAuthor =
	exports.BufferJSON =
	exports.jitterDelay =
	exports.exponentialBackoff =
	exports.bytesToHex =
	exports.hexToBytes =
	exports.bytesToBase64Url =
	exports.sha256Hex =
	exports.hmacSha256 =
	exports.normalizeJidBatch =
	exports.sleep =
	exports.withRetry =
		void 0
exports.promiseTimeout = promiseTimeout
exports.bindWaitForEvent = bindWaitForEvent
exports.trimUndefined = trimUndefined
exports.bytesToCrockford = bytesToCrockford
exports.encodeNewsletterMessage = encodeNewsletterMessage
const boom_1 = require('@hapi/boom')
const crypto_1 = require('crypto')
const rb = require('whatsapp-rust-bridge-baron')
const DEFAULTS_1 = require('../Defaults')
const index_js_1 = require('../../WAProto/index.js')
const baileysVersion = DEFAULTS_1.VERSION
const Types_1 = require('../Types')
const WABinary_1 = require('../WABinary')
const crypto_2 = require('./crypto')
exports.BufferJSON = {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	replacer: (k, value) => {
		if (Buffer.isBuffer(value) || value instanceof Uint8Array || value?.type === 'Buffer') {
			return { type: 'Buffer', data: Buffer.from(value?.data || value).toString('base64') }
		}
		return value
	},
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	reviver: (_, value) => {
		if (typeof value === 'object' && value !== null && value.type === 'Buffer' && typeof value.data === 'string') {
			return Buffer.from(value.data, 'base64')
		}
		if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
			const keys = Object.keys(value)
			if (keys.length > 0 && keys.every(k => !isNaN(parseInt(k, 10)))) {
				const values = Object.values(value)
				if (values.every(v => typeof v === 'number')) {
					return Buffer.from(values)
				}
			}
		}
		return value
	}
}
const getKeyAuthor = (key, meId = 'me') =>
	(key?.fromMe ? meId : key?.participantAlt || key?.remoteJidAlt || key?.participant || key?.remoteJid) || ''
exports.getKeyAuthor = getKeyAuthor
const isStringNullOrEmpty = value =>
	// eslint-disable-next-line eqeqeq
	value == null || value === ''
exports.isStringNullOrEmpty = isStringNullOrEmpty
const writeRandomPadMax16 = msg => {
	const pad = (0, crypto_1.randomBytes)(1)
	const padLength = (pad[0] & 0x0f) + 1
	return Buffer.concat([msg, Buffer.alloc(padLength, padLength)])
}
exports.writeRandomPadMax16 = writeRandomPadMax16
const unpadRandomMax16 = e => {
	const t = new Uint8Array(e)
	if (0 === t.length) {
		throw new Error('unpadPkcs7 given empty bytes')
	}
	var r = t[t.length - 1]
	if (r > t.length) {
		throw new Error(`unpad given ${t.length} bytes, but pad is ${r}`)
	}
	return new Uint8Array(t.buffer, t.byteOffset, t.length - r)
}
exports.unpadRandomMax16 = unpadRandomMax16
// code is inspired by whatsmeow
const generateParticipantHashV2 = participants => {
	participants.sort()
	const sha256Hash = (0, crypto_2.sha256)(Buffer.from(participants.join(''))).toString('base64')
	return '2:' + sha256Hash.slice(0, 6)
}
exports.generateParticipantHashV2 = generateParticipantHashV2
const encodeWAMessage = message => (0, exports.writeRandomPadMax16)(index_js_1.proto.Message.encode(message).finish())
exports.encodeWAMessage = encodeWAMessage
const generateRegistrationId = () => {
	return Uint16Array.from((0, crypto_1.randomBytes)(2))[0] & 16383
}
exports.generateRegistrationId = generateRegistrationId
const encodeBigEndian = (e, t = 4) => {
	let r = e
	const a = new Uint8Array(t)
	for (let i = t - 1; i >= 0; i--) {
		a[i] = 255 & r
		r >>>= 8
	}
	return a
}
exports.encodeBigEndian = encodeBigEndian
const toNumber = t => (typeof t === 'object' && t ? ('toNumber' in t ? t.toNumber() : t.low) : t || 0)
exports.toNumber = toNumber
/** unix timestamp of a date in seconds */
const unixTimestampSeconds = (date = new Date()) => Math.floor(date.getTime() / 1000)
exports.unixTimestampSeconds = unixTimestampSeconds
const debouncedTimeout = (intervalMs = 1000, task) => {
	let timeout
	return {
		start: (newIntervalMs, newTask) => {
			task = newTask || task
			intervalMs = newIntervalMs || intervalMs
			timeout && clearTimeout(timeout)
			timeout = setTimeout(() => task?.(), intervalMs)
		},
		cancel: () => {
			timeout && clearTimeout(timeout)
			timeout = undefined
		},
		setTask: newTask => (task = newTask),
		setInterval: newInterval => (intervalMs = newInterval)
	}
}
exports.debouncedTimeout = debouncedTimeout
const delay = ms => (0, exports.delayCancellable)(ms).delay
exports.delay = delay
const delayCancellable = ms => {
	const stack = new Error().stack
	let timeout
	let reject
	const delay = new Promise((resolve, _reject) => {
		timeout = setTimeout(resolve, ms)
		reject = _reject
	})
	const cancel = () => {
		clearTimeout(timeout)
		reject(
			new boom_1.Boom('Cancelled', {
				statusCode: 500,
				data: {
					stack
				}
			})
		)
	}
	return { delay, cancel }
}
exports.delayCancellable = delayCancellable
async function promiseTimeout(ms, promise) {
	if (!ms) {
		return new Promise(promise)
	}
	const stack = new Error().stack
	// Create a promise that rejects in <ms> milliseconds
	const { delay, cancel } = (0, exports.delayCancellable)(ms)
	const p = new Promise((resolve, reject) => {
		delay
			.then(() =>
				reject(
					new boom_1.Boom('Timed Out', {
						statusCode: Types_1.DisconnectReason.timedOut,
						data: {
							stack
						}
					})
				)
			)
			.catch(err => reject(err))
		promise(resolve, reject)
	}).finally(cancel)
	return p
}
// inspired from whatsmeow code
// https://github.com/tulir/whatsmeow/blob/64bc969fbe78d31ae0dd443b8d4c80a5d026d07a/send.go#L42
const generateMessageIDV2 = userId => {
	const data = Buffer.alloc(8 + 20 + 16)
	data.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000)))
	if (userId) {
		const id = (0, WABinary_1.jidDecode)(userId)
		if (id?.user) {
			data.write(id.user, 8)
			data.write('@c.us', 8 + id.user.length)
		}
	}
	const random = (0, crypto_1.randomBytes)(16)
	random.copy(data, 28)
	const hash = Buffer.from(rb.sha256(data))
	return '3EB0' + hash.toString('hex').toUpperCase().substring(0, 18)
}
exports.generateMessageIDV2 = generateMessageIDV2
// generate a random ID to attach to a message
const generateMessageID = () => '3EB0' + (0, crypto_1.randomBytes)(18).toString('hex').toUpperCase()
exports.generateMessageID = generateMessageID
function bindWaitForEvent(ev, event) {
	return async (check, timeoutMs) => {
		let listener
		let closeListener
		await promiseTimeout(timeoutMs, (resolve, reject) => {
			closeListener = ({ connection, lastDisconnect }) => {
				if (connection === 'close') {
					reject(
						lastDisconnect?.error ||
							new boom_1.Boom('Connection Closed', { statusCode: Types_1.DisconnectReason.connectionClosed })
					)
				}
			}
			ev.on('connection.update', closeListener)
			listener = async update => {
				if (await check(update)) {
					resolve()
				}
			}
			ev.on(event, listener)
		}).finally(() => {
			ev.off(event, listener)
			ev.off('connection.update', closeListener)
		})
	}
}
const bindWaitForConnectionUpdate = ev => bindWaitForEvent(ev, 'connection.update')
exports.bindWaitForConnectionUpdate = bindWaitForConnectionUpdate
/**
 * utility that fetches latest baileys version from the master branch.
 * Use to ensure your WA connection is always on the latest version
 */
const fetchLatestBaileysVersion = async (options = {}) => {
	const URL = 'https://raw.githubusercontent.com/WhiskeySockets/Baileys/master/src/Defaults/index.ts'
	try {
		const response = await fetch(URL, {
			dispatcher: options.dispatcher,
			method: 'GET',
			headers: options.headers
		})
		if (!response.ok) {
			throw new boom_1.Boom(`Failed to fetch latest Baileys version: ${response.statusText}`, {
				statusCode: response.status
			})
		}
		const text = await response.text()
		// Extract version from line 7 (const version = [...])
		const lines = text.split('\n')
		const versionLine = lines[6] // Line 7 (0-indexed)
		const versionMatch = versionLine.match(/const version = \[(\d+),\s*(\d+),\s*(\d+)\]/)
		if (versionMatch) {
			const version = [parseInt(versionMatch[1], 10), parseInt(versionMatch[2], 10), parseInt(versionMatch[3], 10)]
			return {
				version,
				isLatest: true
			}
		} else {
			throw new Error('Could not parse version from Defaults/index.ts')
		}
	} catch (error) {
		return {
			version: baileysVersion,
			isLatest: false,
			error
		}
	}
}
exports.fetchLatestBaileysVersion = fetchLatestBaileysVersion
/**
 * A utility that fetches the latest web version of whatsapp.
 * Use to ensure your WA connection is always on the latest version
 */
const fetchLatestWaWebVersion = async (options = {}) => {
	try {
		// Absolute minimal headers required to bypass anti-bot detection
		const defaultHeaders = {
			'sec-fetch-site': 'none',
			'user-agent':
				'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
		}
		const headers = { ...defaultHeaders, ...options.headers }
		const response = await fetch('https://web.whatsapp.com/sw.js', {
			...options,
			method: 'GET',
			headers
		})
		if (!response.ok) {
			throw new boom_1.Boom(`Failed to fetch sw.js: ${response.statusText}`, { statusCode: response.status })
		}
		const data = await response.text()
		const regex = /\\?"client_revision\\?":\s*(\d+)/
		const match = data.match(regex)
		if (!match?.[1]) {
			return {
				version: baileysVersion,
				isLatest: false,
				error: {
					message: 'Could not find client revision in the fetched content'
				}
			}
		}
		const clientRevision = match[1]
		return {
			version: [2, 3000, +clientRevision],
			isLatest: true
		}
	} catch (error) {
		return {
			version: baileysVersion,
			isLatest: false,
			error
		}
	}
}
exports.fetchLatestWaWebVersion = fetchLatestWaWebVersion
/** unique message tag prefix for MD clients */
const generateMdTagPrefix = () => {
	const bytes = (0, crypto_1.randomBytes)(4)
	return `${bytes.readUInt16BE()}.${bytes.readUInt16BE(2)}-`
}
exports.generateMdTagPrefix = generateMdTagPrefix
const STATUS_MAP = {
	sender: index_js_1.proto.WebMessageInfo.Status.SERVER_ACK,
	played: index_js_1.proto.WebMessageInfo.Status.PLAYED,
	'played-self': index_js_1.proto.WebMessageInfo.Status.PLAYED,
	read: index_js_1.proto.WebMessageInfo.Status.READ,
	'read-self': index_js_1.proto.WebMessageInfo.Status.READ
}
/**
 * Given a type of receipt, returns what the new status of the message should be
 * @param type type from receipt
 */
const getStatusFromReceiptType = type => {
	const status = STATUS_MAP[type]
	if (typeof type === 'undefined') {
		return index_js_1.proto.WebMessageInfo.Status.DELIVERY_ACK
	}
	return status
}
exports.getStatusFromReceiptType = getStatusFromReceiptType
const CODE_MAP = {
	conflict: Types_1.DisconnectReason.connectionReplaced
}
/**
 * Stream errors generally provide a reason, map that to a baileys DisconnectReason
 * @param reason the string reason given, eg. "conflict"
 */
const getErrorCodeFromStreamError = node => {
	const [reasonNode] = (0, WABinary_1.getAllBinaryNodeChildren)(node)
	let reason = reasonNode?.tag || 'unknown'
	const statusCode = +(node.attrs.code || CODE_MAP[reason] || Types_1.DisconnectReason.badSession)
	if (statusCode === Types_1.DisconnectReason.restartRequired) {
		reason = 'restart required'
	}
	return {
		reason,
		statusCode
	}
}
exports.getErrorCodeFromStreamError = getErrorCodeFromStreamError
const getCallStatusFromNode = ({ tag, attrs }) => {
	let status
	switch (tag) {
		case 'offer':
		case 'offer_notice':
			status = 'offer'
			break
		case 'terminate':
			// Map known end-call reasons to distinct statuses
			switch (attrs.reason) {
				case 'timeout':
				case 'Timeout':
					status = 'timeout'
					break
				case 'RejectDoNotDisturb':
					status = 'reject_do_not_disturb'
					break
				case 'MicPermissionDenied':
					status = 'mic_permission_denied'
					break
				case 'CameraPermissionDenied':
					status = 'camera_permission_denied'
					break
				case 'RemoteBusy':
					status = 'remote_busy'
					break
				case 'RemoteOffline':
					status = 'remote_offline'
					break
				default:
					// fired when accepted/rejected/caller hangs up
					status = 'terminate'
					break
			}
			break
		case 'reject':
			status = 'reject'
			break
		case 'accept':
			status = 'accept'
			break
		case 'preaccept':
			status = 'preaccept'
			break
		case 'accept_ack':
			status = 'accept_ack'
			break
		case 'enc-rekey':
		case 'enc_rekey':
			status = 'enc_rekey'
			break
		case 'peer_state':
			status = 'peer_state'
			break
		case 'group_info':
			status = 'group_info'
			break
		case 'video_state':
			status = 'video_state'
			break
		case 'video_state_ack':
			status = 'video_state_ack'
			break
		case 'flow_control':
			status = 'flow_control'
			break
		case 'relaylatency':
			status = 'relaylatency'
			break
		case 'mute_v2':
			status = 'mute'
			break
		case 'waiting_room_request':
			status = 'waiting_room_request'
			break
		case 'signal':
			// Numeric type mapping for <signal type="N"/> child nodes
			switch (attrs.type) {
				case '13':
					status = 'preaccept'
					break
				case '15':
					status = 'video_state'
					break
				case '17':
					status = 'group_info'
					break
				case '20':
					status = 'video_state_ack'
					break
				case '21':
					status = 'flow_control'
					break
				case '23':
					status = 'accept_ack'
					break
				case '1002':
				case '1007':
					status = 'peer_state'
					break
				case '1008':
					status = 'enc_rekey'
					break
				case '12':
					status = 'mute'
					break
				default:
					status = 'ringing'
					break
			}
			break
		default:
			status = 'ringing'
			break
	}
	return status
}
exports.getCallStatusFromNode = getCallStatusFromNode
const UNEXPECTED_SERVER_CODE_TEXT = 'Unexpected server response: '
const getCodeFromWSError = error => {
	let statusCode = 500
	if (error?.message?.includes(UNEXPECTED_SERVER_CODE_TEXT)) {
		const code = +error?.message.slice(UNEXPECTED_SERVER_CODE_TEXT.length)
		if (!Number.isNaN(code) && code >= 400) {
			statusCode = code
		}
	} else if (
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		error?.code?.startsWith('E') ||
		error?.message?.includes('timed out')
	) {
		// handle ETIMEOUT, ENOTFOUND etc
		statusCode = 408
	}
	return statusCode
}
exports.getCodeFromWSError = getCodeFromWSError
/**
 * Is the given platform WA business
 * @param platform AuthenticationCreds.platform
 */
const isWABusinessPlatform = platform => {
	return platform === 'smbi' || platform === 'smba'
}
exports.isWABusinessPlatform = isWABusinessPlatform
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function trimUndefined(obj) {
	for (const key in obj) {
		if (typeof obj[key] === 'undefined') {
			delete obj[key]
		}
	}
	return obj
}
const CROCKFORD_CHARACTERS = '123456789ABCDEFGHJKLMNPQRSTVWXYZ'
function bytesToCrockford(buffer) {
	let value = 0
	let bitCount = 0
	const crockford = []
	for (const element of buffer) {
		value = (value << 8) | (element & 0xff)
		bitCount += 8
		while (bitCount >= 5) {
			crockford.push(CROCKFORD_CHARACTERS.charAt((value >>> (bitCount - 5)) & 31))
			bitCount -= 5
		}
	}
	if (bitCount > 0) {
		crockford.push(CROCKFORD_CHARACTERS.charAt((value << (5 - bitCount)) & 31))
	}
	return crockford.join('')
}
function encodeNewsletterMessage(message) {
	return index_js_1.proto.Message.encode(message).finish()
}

/**
 * Add human-like jitter to a base delay
 * @param baseMs base delay in milliseconds
 * @param varianceFraction fraction of baseMs to use as variance (0–1), default 0.3
 */
const jitterDelay = (baseMs, varianceFraction = 0.3) => {
	const variance = baseMs * varianceFraction
	return baseMs + (Math.random() * 2 - 1) * variance
}
exports.jitterDelay = jitterDelay

/**
 * Compute exponential backoff delay for a given attempt number (0-based)
 * @param attempt attempt index (0 = first retry)
 * @param baseMs starting delay in ms (default 500)
 * @param maxMs maximum delay cap in ms (default 30000)
 */
const exponentialBackoff = (attempt, baseMs = 500, maxMs = 30000) => {
	return Math.min(baseMs * Math.pow(2, attempt), maxMs)
}
exports.exponentialBackoff = exponentialBackoff

/** Convert buffer/Uint8Array to hex string */
const bytesToHex = buf => Buffer.from(buf).toString('hex')
exports.bytesToHex = bytesToHex

/** Convert hex string to Buffer */
const hexToBytes = hex => Buffer.from(hex, 'hex')
exports.hexToBytes = hexToBytes

/** Convert buffer to base64url string */
const bytesToBase64Url = buf => Buffer.from(buf).toString('base64url')
exports.bytesToBase64Url = bytesToBase64Url

/** Compute SHA-256 hex digest of data */
const sha256Hex = data => (0, crypto_1.createHash)('sha256').update(data).digest('hex')
exports.sha256Hex = sha256Hex

/** Compute HMAC-SHA-256 of data with key, returns Buffer */
const hmacSha256 = (data, key) => (0, crypto_1.createHmac)('sha256', key).update(data).digest()
exports.hmacSha256 = hmacSha256

/**
 * Normalize and deduplicate an array of JIDs
 */
const normalizeJidBatch = (jids, normalizer) => {
	const seen = new Set()
	const result = []
	for (const jid of jids) {
		if (!jid) continue
		const normalized = normalizer ? normalizer(jid) : jid
		if (!seen.has(normalized)) {
			seen.add(normalized)
			result.push(normalized)
		}
	}
	return result
}
exports.normalizeJidBatch = normalizeJidBatch

/**
 * Sleep for a given number of milliseconds, returns a cancellable promise
 */
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
exports.sleep = sleep

/**
 * Run an async function with retry using exponential backoff
 * @param fn async function to retry
 * @param maxAttempts maximum number of attempts
 * @param baseDelayMs base delay between retries
 */
const withRetry = async (fn, maxAttempts = 3, baseDelayMs = 500) => {
	let lastErr
	for (let i = 0; i < maxAttempts; i++) {
		try {
			return await fn()
		} catch (err) {
			lastErr = err
			if (i < maxAttempts - 1) {
				await sleep(exponentialBackoff(i, baseDelayMs))
			}
		}
	}
	throw lastErr
}
exports.withRetry = withRetry
