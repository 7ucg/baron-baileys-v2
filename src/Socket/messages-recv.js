'use strict'
var __importDefault =
	(this && this.__importDefault) ||
	function (mod) {
		return mod && mod.__esModule ? mod : { default: mod }
	}
Object.defineProperty(exports, '__esModule', { value: true })
exports.makeMessagesRecvSocket = void 0
const node_cache_1 = __importDefault(require('@cacheable/node-cache'))
const boom_1 = require('@hapi/boom')
const crypto_1 = require('crypto')
const index_js_1 = require('../../WAProto/index.js')
const Defaults_1 = require('../Defaults')
const Types_1 = require('../Types')
const Utils_1 = require('../Utils')
const jid_display_normalization_1 = require('../Utils/jid-display-normalization')
const make_mutex_1 = require('../Utils/make-mutex')
const offline_node_processor_1 = require('../Utils/offline-node-processor')
const stanza_ack_1 = require('../Utils/stanza-ack')
const tc_token_utils_1 = require('../Utils/tc-token-utils')
const WABinary_1 = require('../WABinary')
const groups_1 = require('./groups')
const aigroup_1 = require('./aigroups')
const messages_send_1 = require('./messages-send')

const makeMessagesRecvSocket = config => {
	const { logger, retryRequestDelayMs, maxMsgRetryCount, getMessage, shouldIgnoreJid, enableAutoSessionRecreation } =
		config
	const sock = (0, messages_send_1.makeMessagesSocket)(config)
	const {
		ev,
		authState,
		ws,
		messageMutex,
		notificationMutex,
		receiptMutex,
		signalRepository,
		query,
		upsertMessage,
		resyncAppState,
		onUnexpectedError,
		assertSessions,
		sendNode,
		relayMessage,
		sendReceipt,
		uploadPreKeys,
		sendPeerDataOperationMessage,
		messageRetryManager,
		issuePrivacyTokens,
		getUSyncDevices,
		createParticipantNodes,
		newsletterServerIdCache
	} = sock
	const getLIDForPN = signalRepository.lidMapping.getLIDForPN.bind(signalRepository.lidMapping)
	// Track when the socket fully opens so pending pre-connect messages are treated as history
	const socketCreatedAt = Math.floor(Date.now() / 1000)
	let isConnected = false
	/** this mutex ensures that each retryRequest will wait for the previous one to finish */
	const retryMutex = (0, make_mutex_1.makeMutex)()
	const msgRetryCache =
		config.msgRetryCounterCache ||
		new node_cache_1.default({
			stdTTL: Defaults_1.DEFAULT_CACHE_TTLS.MSG_RETRY, // 1 hour
			useClones: false
		})
	const callOfferCache =
		config.callOfferCache ||
		new node_cache_1.default({
			stdTTL: Defaults_1.DEFAULT_CACHE_TTLS.CALL_OFFER, // 5 mins
			useClones: false
		})
	const placeholderResendCache =
		config.placeholderResendCache ||
		new node_cache_1.default({
			stdTTL: Defaults_1.DEFAULT_CACHE_TTLS.MSG_RETRY, // 1 hour
			useClones: false
		})
	// Debounce identity-change session refreshes per JID to avoid bursts
	const identityAssertDebounce = new node_cache_1.default({ stdTTL: 5, useClones: false })
	let sendActiveReceipts = false
	const fetchMessageHistory = async (count, oldestMsgKey, oldestMsgTimestamp) => {
		if (!authState.creds.me?.id) {
			throw new boom_1.Boom('Not authenticated')
		}
		const pdoMessage = {
			historySyncOnDemandRequest: {
				chatJid: oldestMsgKey.remoteJid,
				oldestMsgFromMe: oldestMsgKey.fromMe,
				oldestMsgId: oldestMsgKey.id,
				oldestMsgTimestampMs: oldestMsgTimestamp,
				onDemandMsgCount: count
			},
			peerDataOperationRequestType: index_js_1.proto.Message.PeerDataOperationRequestType.HISTORY_SYNC_ON_DEMAND
		}
		return sendPeerDataOperationMessage(pdoMessage)
	}
	const requestPlaceholderResend = async (messageKey, msgData) => {
		if (!authState.creds.me?.id) {
			throw new boom_1.Boom('Not authenticated')
		}
		if (await placeholderResendCache.get(messageKey?.id)) {
			logger.debug({ messageKey }, 'already requested resend')
			return
		} else {
			// Store original message data so PDO response handler can preserve
			// metadata (LID details, timestamps, etc.) that the phone may omit
			await placeholderResendCache.set(messageKey?.id, msgData || true)
		}
		await (0, Utils_1.delay)(2000)
		if (!(await placeholderResendCache.get(messageKey?.id))) {
			logger.debug({ messageKey }, 'message received while resend requested')
			return 'RESOLVED'
		}
		const pdoMessage = {
			placeholderMessageResendRequest: [
				{
					messageKey
				}
			],
			peerDataOperationRequestType: index_js_1.proto.Message.PeerDataOperationRequestType.PLACEHOLDER_MESSAGE_RESEND
		}
		setTimeout(async () => {
			if (await placeholderResendCache.get(messageKey?.id)) {
				logger.debug({ messageKey }, 'PDO message without response after 8 seconds. Phone possibly offline')
				await placeholderResendCache.del(messageKey?.id)
			}
		}, 8000)
		return sendPeerDataOperationMessage(pdoMessage)
	}
	/**
	 * Request a Waffle (Meta-account) linking nonce from the paired phone.
	 * The phone responds via a PeerDataOperationRequestResponseMessage containing
	 * a WaffleNonceFetchResponse with the nonce needed for Meta account linking.
	 */
	const requestWaffleNonce = async () => {
		if (!authState.creds.me?.id) {
			throw new boom_1.Boom('Not authenticated')
		}
		return sendPeerDataOperationMessage({
			peerDataOperationRequestType: index_js_1.proto.Message.PeerDataOperationRequestType.WAFFLE_LINKING_NONCE_FETCH
		})
	}
	/**
	 * Request a Companion Canonical User nonce from the paired phone.
	 * Used during companion linking to canonicalize the user identity across devices.
	 * The phone responds with a CompanionCanonicalUserNonceFetchResponse (nonce + waFbid).
	 *
	 * @param {string} [registrationTraceId] - Optional trace ID for this registration attempt.
	 */
	const requestCompanionCanonicalNonce = async registrationTraceId => {
		if (!authState.creds.me?.id) {
			throw new boom_1.Boom('Not authenticated')
		}
		return sendPeerDataOperationMessage({
			companionCanonicalUserNonceFetchRequest: registrationTraceId ? { registrationTraceId } : {},
			peerDataOperationRequestType:
				index_js_1.proto.Message.PeerDataOperationRequestType.COMPANION_CANONICAL_USER_NONCE_FETCH
		})
	}
	/**
	 * Request a Companion Meta nonce from the paired phone.
	 * Used during Meta-account companion linking flow.
	 * The phone responds with a CompanionMetaNonceFetchResponse (nonce).
	 */
	const requestCompanionMetaNonce = async () => {
		if (!authState.creds.me?.id) {
			throw new boom_1.Boom('Not authenticated')
		}
		return sendPeerDataOperationMessage({
			peerDataOperationRequestType: index_js_1.proto.Message.PeerDataOperationRequestType.COMPANION_META_NONCE_FETCH
		})
	}
	// Handles mex notifications (newsletter and group XWA2 property updates).
	// Wire format: notification[type=mex] → <update op_name="..."> → JSON payload in content bytes.
	const handleMexNotification = async node => {
		const updateNodes = (0, WABinary_1.getBinaryNodeChildren)(node, 'update')
		if (!updateNodes.length) {
			logger.debug({ node }, 'mex notification with no update children')
			return
		}
		for (const updateNode of updateNodes) {
			const opName = updateNode.attrs?.op_name
			if (!opName) continue
			let payload
			try {
				const raw = updateNode.content?.text ?? updateNode.content?.toString?.()
				payload = raw ? JSON.parse(raw) : null
			} catch (e) {
				logger.error({ err: e, opName }, 'failed to parse mex update payload')
				continue
			}
			if (!payload?.data) {
				logger.debug({ opName }, 'mex update with no data field')
				continue
			}
			const d = payload.data
			switch (opName) {
				case 'NotificationNewsletterUpdate': {
					// d.xwa2_notify_newsletter_on_metadata_update: { id, thread_metadata: { settings } }
					const upd = d.xwa2_notify_newsletter_on_metadata_update
					if (upd?.id) {
						ev.emit('newsletter-settings.update', {
							id: upd.id,
							update: upd.thread_metadata?.settings ?? {}
						})
					}
					break
				}
				case 'NotificationNewsletterJoin': {
					// d.xwa2_notify_newsletter_on_join: full newsletter metadata on subscribe
					const upd = d.xwa2_notify_newsletter_on_join
					if (upd?.id) {
						ev.emit('newsletter-participants.update', {
							id: upd.id,
							author: node.attrs.from,
							user: (0, WABinary_1.jidNormalizedUser)(node.attrs.from),
							new_role: upd.viewer_metadata?.role ?? 'SUBSCRIBER',
							action: 'join',
							metadata: upd.thread_metadata
						})
					}
					break
				}
				case 'NotificationNewsletterMuteChange': {
					// d.xwa2_notify_newsletter_on_mute_change: { id, mute: "ON"|"OFF" }
					const upd = d.xwa2_notify_newsletter_on_mute_change
					if (upd?.id) {
						ev.emit('newsletter-settings.update', {
							id: upd.id,
							update: { mute: upd.mute }
						})
					}
					break
				}
				case 'NotificationNewsletterUserSettingChange': {
					// d.xwa2_notify_newsletter_on_user_setting_change: { id, setting: { type, value } }
					const upd = d.xwa2_notify_newsletter_on_user_setting_change
					if (upd?.id && upd.setting) {
						ev.emit('newsletter-settings.update', {
							id: upd.id,
							update: { userSetting: upd.setting }
						})
					}
					break
				}
				case 'NotificationNewsletterAdminPromote': {
					// legacy format kept for compat
					const upd = d.xwa2_notify_newsletter_on_admin_promote
					if (upd?.id) {
						ev.emit('newsletter-participants.update', {
							id: upd.id,
							author: node.attrs.from,
							user: upd.user,
							new_role: 'ADMIN',
							action: 'promote'
						})
					}
					break
				}
				case 'NotificationGroupMemberLinkPropertyUpdate': {
					// d.xwa2_notify_group_on_prop_change: { id, properties: { member_link_mode } }
					const upd = d.xwa2_notify_group_on_prop_change
					if (upd?.id && upd.properties?.member_link_mode !== undefined) {
						ev.emit('groups.update', [
							{
								id: upd.id,
								memberAddMode: upd.properties.member_link_mode
							}
						])
					}
					break
				}
				case 'NotificationGroupLimitSharingPropertyUpdate': {
					// d.xwa2_notify_group_on_prop_change: { id, properties: { limit_sharing } }
					const upd = d.xwa2_notify_group_on_prop_change
					if (upd?.id && upd.properties?.limit_sharing !== undefined) {
						ev.emit('groups.update', [
							{
								id: upd.id,
								limitSharing: upd.properties.limit_sharing
							}
						])
					}
					break
				}
				case 'NotificationGroupMemberShareGroupHistoryModePropertyUpdate': {
					// d.xwa2_notify_group_on_prop_change: { id, properties: { member_share_group_history_mode } }
					const upd = d.xwa2_notify_group_on_prop_change
					if (upd?.id && upd.properties?.member_share_group_history_mode !== undefined) {
						ev.emit('groups.update', [
							{
								id: upd.id,
								memberShareHistoryMode: upd.properties.member_share_group_history_mode
							}
						])
					}
					break
				}
				default:
					logger.debug({ opName, from: node.attrs.from }, 'unhandled mex op')
			}
		}
	}
	// Handles newsletter notifications
	const handleNewsletterNotification = async node => {
		const from = node.attrs.from
		const child = (0, WABinary_1.getAllBinaryNodeChildren)(node)[0]
		const author = node.attrs.participant
		logger.info({ from, child }, 'got newsletter notification')
		switch (child.tag) {
			case 'reaction':
				const reactionUpdate = {
					id: from,
					server_id: child.attrs.message_id,
					reaction: {
						code: (0, WABinary_1.getBinaryNodeChildString)(child, 'reaction'),
						count: 1
					}
				}
				ev.emit('newsletter.reaction', reactionUpdate)
				break
			case 'view':
				const viewUpdate = {
					id: from,
					server_id: child.attrs.message_id,
					count: parseInt(child.content?.toString() || '0', 10)
				}
				ev.emit('newsletter.view', viewUpdate)
				break
			case 'participant':
				const participantUpdate = {
					id: from,
					author,
					user: child.attrs.jid,
					action: child.attrs.action,
					new_role: child.attrs.role
				}
				ev.emit('newsletter-participants.update', participantUpdate)
				break
			case 'update':
				const settingsNode = (0, WABinary_1.getBinaryNodeChild)(child, 'settings')
				if (settingsNode) {
					const update = {}
					const nameNode = (0, WABinary_1.getBinaryNodeChild)(settingsNode, 'name')
					if (nameNode?.content) update.name = nameNode.content.toString()
					const descriptionNode = (0, WABinary_1.getBinaryNodeChild)(settingsNode, 'description')
					if (descriptionNode?.content) update.description = descriptionNode.content.toString()
					ev.emit('newsletter-settings.update', {
						id: from,
						update
					})
				}
				break
			case 'message': {
				const viewCount = child.attrs.view_count !== undefined ? +child.attrs.view_count : undefined
				const impressionCount = child.attrs.impression_count !== undefined ? +child.attrs.impression_count : undefined
				const plaintextNode = (0, WABinary_1.getBinaryNodeChild)(child, 'plaintext')
				if (plaintextNode?.content) {
					try {
						const contentBuf =
							typeof plaintextNode.content === 'string'
								? Buffer.from(plaintextNode.content, 'binary')
								: Buffer.from(plaintextNode.content)
						const messageProto = index_js_1.proto.Message.decode(contentBuf).toJSON()
						const fullMessage = index_js_1.proto.WebMessageInfo.fromObject({
							key: {
								remoteJid: from,
								id: child.attrs.message_id || child.attrs.server_id,
								// always false: this branch only runs for inbound plaintext newsletter posts,
								// which always originate from the channel, never from us
								fromMe: false
							},
							message: messageProto,
							messageTimestamp: +child.attrs.t
						}).toJSON()
						// Attach insight counters when the server includes them
						if (viewCount !== undefined) fullMessage.views = viewCount
						if (impressionCount !== undefined) fullMessage.impressions = impressionCount
						await upsertMessage(fullMessage, 'append')
						logger.info('Processed plaintext newsletter message')
					} catch (error) {
						logger.error({ error }, 'Failed to decode plaintext newsletter message')
					}
				}
				break
			}
			case 'live_updates': {
				// Live engagement updates: reactions + forwards per message.
				// Wire: <live_updates> → <messages t="..."> → <message server_id="...">
				//         → <forwards_count count="N">, <reactions> → <reaction code="X" count="N">
				const messagesNode = (0, WABinary_1.getBinaryNodeChild)(child, 'messages')
				const msgTs = messagesNode?.attrs?.t ? +messagesNode.attrs.t : undefined
				for (const msgNode of (0, WABinary_1.getBinaryNodeChildren)(messagesNode ?? child, 'message')) {
					const serverId = msgNode.attrs.server_id
					const fwdNode = (0, WABinary_1.getBinaryNodeChild)(msgNode, 'forwards_count')
					const forwardsCount = fwdNode?.attrs?.count !== undefined ? +fwdNode.attrs.count : undefined
					const reactionsNode = (0, WABinary_1.getBinaryNodeChild)(msgNode, 'reactions')
					const reactions = (0, WABinary_1.getBinaryNodeChildren)(reactionsNode ?? msgNode, 'reaction').map(r => ({
						code: r.attrs.code,
						count: +r.attrs.count
					}))
					ev.emit('newsletter.live-update', {
						id: from,
						server_id: serverId,
						timestamp: msgTs,
						forwardsCount,
						reactions
					})
				}
				break
			}
			case 'pin': {
				const pinnedServerId = child.attrs.message_id || child.attrs.server_id
				const isPinned = child.attrs.action !== 'unpin'
				ev.emit('newsletter.pin', {
					id: from,
					server_id: pinnedServerId,
					pinned: isPinned
				})
				// Sync the pinnedMessage field on the newsletter metadata object
				ev.emit('newsletters.update', [{ id: from, pinnedMessage: isPinned ? pinnedServerId : null }])
				break
			}
			case 'category':
				ev.emit('newsletter-settings.update', {
					id: from,
					update: { category: child.attrs.value || child.content?.toString() }
				})
				break
			case 'invite':
				ev.emit('newsletter.invite', {
					id: from,
					inviteCode: child.attrs.code,
					inviter: child.attrs.jid || author,
					role: child.attrs.role || 'SUBSCRIBER'
				})
				break
			default:
				logger.warn({ node }, 'Unknown newsletter notification')
				break
		}
	}
	// Handles incoming <status> stanzas pushed by the server for newsletter posts.
	// These arrive on the CB:status channel (AB-gated by status_e2ee_recv_over_status_stanza).
	const handleNewsletterStatus = async node => {
		const { id, from, server_id, t, is_sender, offline, type, edit } = node.attrs
		const serverId = server_id ? +server_id : undefined
		const timestamp = t ? +t : undefined
		const isSender = is_sender === 'true'
		const offlineIndex = offline !== undefined ? +offline : undefined
		// Cache messageId → serverId so the bot can look up server_id when a message is quoted
		if (id && serverId != null) {
			newsletterServerIdCache?.set(id, serverId)
		}

		// Parse optional <meta> child: edit timestamps, interaction type, admin profile
		const metaNode = (0, WABinary_1.getBinaryNodeChild)(node, 'meta')
		const meta = metaNode
			? {
					...(metaNode.attrs.msg_edit_t ? { editedAt: +metaNode.attrs.msg_edit_t } : {}),
					...(metaNode.attrs.original_msg_t ? { originalTimestamp: +metaNode.attrs.original_msg_t } : {}),
					...(metaNode.attrs.interaction_type ? { interactionType: metaNode.attrs.interaction_type } : {}),
					...(metaNode.attrs.parent_server_id ? { parentServerId: +metaNode.attrs.parent_server_id } : {}),
					...(metaNode.attrs.response_server_id ? { responseServerId: +metaNode.attrs.response_server_id } : {})
				}
			: undefined

		// Parse engagement counters
		const viewsNode = (0, WABinary_1.getBinaryNodeChild)(node, 'views_count')
		const viewsCount = viewsNode?.attrs?.count !== undefined ? +viewsNode.attrs.count : undefined
		const responsesNode = (0, WABinary_1.getBinaryNodeChild)(node, 'responses_count')
		const responsesCount = responsesNode?.attrs?.count !== undefined ? +responsesNode.attrs.count : undefined
		const reactionsNode = (0, WABinary_1.getBinaryNodeChild)(node, 'reactions')
		const reactionCounts = (0, WABinary_1.getBinaryNodeChildren)(reactionsNode ?? { content: [] }, 'reaction').map(
			r => ({ code: r.attrs.code, count: +r.attrs.count })
		)

		let content = null
		let mediaType = undefined

		if (type === 'reaction') {
			const reactionNode = (0, WABinary_1.getBinaryNodeChild)(node, 'reaction')
			content = { type: 'reaction', code: reactionNode?.attrs?.code }
		} else if (type === 'text' || type === 'media') {
			const plaintextNode = (0, WABinary_1.getBinaryNodeChild)(node, 'plaintext')
			if (type === 'media') mediaType = plaintextNode?.attrs?.mediatype
			if (edit === '7' || edit === '8') {
				content = { type: 'revoke', edit }
			} else if (plaintextNode?.content) {
				try {
					const buf = Buffer.isBuffer(plaintextNode.content)
						? plaintextNode.content
						: Buffer.from(plaintextNode.content)
					const message = index_js_1.proto.Message.decode(buf).toJSON()
					content = { type, message, ...(mediaType ? { mediaType } : {}) }
				} catch (err) {
					logger.error({ err }, 'Failed to decode newsletter status plaintext')
					content = { type, raw: true, ...(mediaType ? { mediaType } : {}) }
				}
			}
		}

		// Send ACK back to server
		const ackType = type === 'reaction' ? 'reaction' : edit ? 'revoke' : type
		await sendNode({
			tag: 'ack',
			attrs: { id, to: from, class: 'status', type: ackType || 'text' },
			content: undefined
		})

		ev.emit('newsletter.status', {
			id: from,
			messageId: id,
			serverId,
			timestamp,
			isSender,
			...(offlineIndex !== undefined ? { offlineIndex } : {}),
			...(meta ? { meta } : {}),
			...(viewsCount !== undefined ? { viewsCount } : {}),
			...(responsesCount !== undefined ? { responsesCount } : {}),
			...(reactionCounts.length ? { reactionCounts } : {}),
			content
		})
	}
	const sendMessageAck = async (node, errorCode) => {
		const stanza = (0, stanza_ack_1.buildAckStanza)(node, errorCode, authState.creds.me.id)
		logger.debug({ recv: { tag: node.tag, attrs: node.attrs }, sent: stanza.attrs }, 'sent ack')
		await sendNode(stanza)
	}

	const offerCall = async (toJid, isVideo = false) => {
		const callId = crypto_1.randomBytes(16).toString('hex').toUpperCase().substring(0, 64)
		const offerContent = []
		offerContent.push({
			tag: 'audio',
			attrs: { enc: 'opus', rate: '16000' },
			content: undefined
		})
		offerContent.push({
			tag: 'audio',
			attrs: { enc: 'opus', rate: '8000' },
			content: undefined
		})

		if (isVideo) {
			offerContent.push({
				tag: 'video',
				attrs: {
					enc: 'vp8',
					dec: 'vp8',
					orientation: '0',
					screen_width: '1920',
					screen_height: '1080',
					device_orientation: '0'
				},
				content: undefined
			})
		}
		offerContent.push({
			tag: 'net',
			attrs: { medium: '3' },
			content: undefined
		})
		offerContent.push({
			tag: 'capability',
			attrs: { ver: '1' },
			content: new Uint8Array([1, 4, 255, 131, 207, 4])
		})
		offerContent.push({
			tag: 'encopt',
			attrs: { keygen: '2' },
			content: undefined
		})

		const encKey = crypto_1.randomBytes(32)
		const devices = (await getUSyncDevices([toJid], true, false)).map(({ user, device }) =>
			WABinary_1.jidEncode(user, 's.whatsapp.net', device)
		)
		await assertSessions(devices, true)

		const { nodes: destinations, shouldIncludeDeviceIdentity } = await createParticipantNodes(
			devices,
			{
				call: {
					callKey: new Uint8Array(encKey)
				}
			},
			{ count: '0' }
		)
		offerContent.push({ tag: 'destination', attrs: {}, content: destinations })

		if (shouldIncludeDeviceIdentity) {
			offerContent.push({
				tag: 'device-identity',
				attrs: {},
				content: Utils_1.encodeSignedDeviceIdentity(authState.creds.account, true)
			})
		}

		const stanza = {
			tag: 'call',
			attrs: {
				id: Utils_1.generateMessageID(),
				to: toJid
			},
			content: [
				{
					tag: 'offer',
					attrs: {
						'call-id': callId,
						'call-creator': authState.creds.me.id
					},
					content: offerContent
				}
			]
		}

		await query(stanza)

		return {
			id: callId,
			to: toJid
		}
	}

	const rejectCall = async (callId, callFrom) => {
		const stanza = {
			tag: 'call',
			attrs: {
				from: authState.creds.me.id,
				to: callFrom
			},
			content: [
				{
					tag: 'reject',
					attrs: {
						'call-id': callId,
						'call-creator': callFrom,
						count: '0'
					},
					content: undefined
				}
			]
		}
		await query(stanza)
	}

	const acceptCall = async (callId, callFrom) => {
		const stanza = {
			tag: 'call',
			attrs: {
				from: authState.creds.me.id,
				to: callFrom
			},
			content: [
				{
					tag: 'accept',
					attrs: {
						'call-id': callId,
						'call-creator': callFrom,
						count: '0'
					},
					content: undefined
				}
			]
		}
		await query(stanza)
	}

	const terminateCall = async (callId, callFrom) => {
		const stanza = {
			tag: 'call',
			attrs: {
				from: authState.creds.me.id,
				to: callFrom
			},
			content: [
				{
					tag: 'terminate',
					attrs: {
						'call-id': callId,
						'call-creator': callFrom,
						reason: 'user-terminated',
						count: '0'
					},
					content: undefined
				}
			]
		}
		await query(stanza)
	}

	/**
	 * Re-encrypt call key for a device that reconnected mid-call.
	 * Source: OutgoingSignalingHandler.java enc_rekey / rekeyEncryptionTask
	 *
	 * @param {string} callId - Active call ID
	 * @param {string} callFrom - JID of the call creator
	 * @param {Buffer} encryptedKeyBytes - Re-encrypted call session key bytes
	 * @param {number} [count=0] - Retry counter (0–4)
	 */
	const rekeyCall = async (callId, callFrom, encryptedKeyBytes, count = 0) => {
		const stanza = {
			tag: 'call',
			attrs: {
				from: authState.creds.me.id,
				to: callFrom
			},
			content: [
				{
					tag: 'enc_rekey',
					attrs: {
						'call-id': callId,
						'call-creator': callFrom,
						count: count.toString()
					},
					content: [
						{
							tag: 'enc',
							attrs: { v: '2', type: 'msg' },
							content: encryptedKeyBytes
						}
					]
				}
			]
		}
		await query(stanza)
	}

	/**
	 * Join a call via an invite link.
	 * Source: OutgoingSignalingHandler.java link_join tag
	 *
	 * @param {string} callId - Call ID from the link
	 * @param {string} callCreator - JID of the call creator
	 * @param {string} linkToken - Token from the call link
	 */
	const joinCallLink = async (callId, callCreator, linkToken) => {
		const stanza = {
			tag: 'call',
			attrs: {
				from: authState.creds.me.id,
				to: callCreator
			},
			content: [
				{
					tag: 'link_join',
					attrs: {
						'call-id': callId,
						'call-creator': callCreator,
						token: linkToken
					},
					content: undefined
				}
			]
		}
		await query(stanza)
	}

	/**
	 * Query info about a call link before joining.
	 * Source: OutgoingSignalingHandler.java link_query tag
	 *
	 * @param {string} callLinkCode - The call link code to query
	 * @param {string} to - JID to send the query to
	 */
	const queryCallLink = async (callLinkCode, to) => {
		const stanza = {
			tag: 'call',
			attrs: {
				from: authState.creds.me.id,
				to
			},
			content: [
				{
					tag: 'link_query',
					attrs: { code: callLinkCode },
					content: undefined
				}
			]
		}
		return query(stanza)
	}
	const sendRetryRequest = async (node, forceIncludeKeys = false) => {
		const { fullMessage } = (0, Utils_1.decodeMessageNode)(node, authState.creds.me.id, authState.creds.me.lid || '')
		const { key: msgKey } = fullMessage
		const msgId = msgKey.id
		if (messageRetryManager) {
			// Check if we've exceeded max retries using the new system
			if (messageRetryManager.hasExceededMaxRetries(msgId)) {
				logger.debug({ msgId }, 'reached retry limit with new retry manager, clearing')
				messageRetryManager.markRetryFailed(msgId)
				return
			}
			// Increment retry count using new system
			const retryCount = messageRetryManager.incrementRetryCount(msgId)
			// Use the new retry count for the rest of the logic
			const key = `${msgId}:${msgKey?.participant}`
			await msgRetryCache.set(key, retryCount)
		} else {
			// Fallback to old system
			const key = `${msgId}:${msgKey?.participant}`
			let retryCount = (await msgRetryCache.get(key)) || 0
			if (retryCount >= maxMsgRetryCount) {
				logger.debug({ retryCount, msgId }, 'reached retry limit, clearing')
				await msgRetryCache.del(key)
				return
			}
			retryCount += 1
			await msgRetryCache.set(key, retryCount)
		}
		const key = `${msgId}:${msgKey?.participant}`
		const retryCount = (await msgRetryCache.get(key)) || 1
		const { account, signedPreKey, signedIdentityKey: identityKey } = authState.creds
		const fromJid = node.attrs.from
		// Check if we should recreate the session
		let shouldRecreateSession = false
		let recreateReason = ''
		if (enableAutoSessionRecreation && messageRetryManager && retryCount > 1) {
			try {
				// Check if we have a session with this JID
				const sessionId = signalRepository.jidToSignalProtocolAddress(fromJid)
				const hasSession = await signalRepository.validateSession(fromJid)
				const result = messageRetryManager.shouldRecreateSession(fromJid, hasSession.exists)
				shouldRecreateSession = result.recreate
				recreateReason = result.reason
				if (shouldRecreateSession) {
					logger.debug({ fromJid, retryCount, reason: recreateReason }, 'recreating session for retry')
					// Delete existing session to force recreation
					await authState.keys.set({ session: { [sessionId]: null } })
					forceIncludeKeys = true
				}
			} catch (error) {
				logger.warn({ error, fromJid }, 'failed to check session recreation')
			}
		}
		if (retryCount <= 2) {
			// Use new retry manager for phone requests if available
			if (messageRetryManager) {
				// Schedule phone request with delay (like whatsmeow)
				messageRetryManager.schedulePhoneRequest(msgId, async () => {
					try {
						const requestId = await requestPlaceholderResend(msgKey)
						logger.debug(
							`sendRetryRequest: requested placeholder resend (${requestId}) for message ${msgId} (scheduled)`
						)
					} catch (error) {
						logger.warn({ error, msgId }, 'failed to send scheduled phone request')
					}
				})
			} else {
				// Fallback to immediate request
				const msgId = await requestPlaceholderResend(msgKey)
				logger.debug(`sendRetryRequest: requested placeholder resend for message ${msgId}`)
			}
		}
		const deviceIdentity = (0, Utils_1.encodeSignedDeviceIdentity)(account, true)
		await authState.keys.transaction(async () => {
			const receipt = {
				tag: 'receipt',
				attrs: {
					id: msgId,
					type: 'retry',
					to: node.attrs.from
				},
				content: [
					{
						tag: 'retry',
						attrs: {
							count: retryCount.toString(),
							id: node.attrs.id,
							t: node.attrs.t,
							v: '1',
							// Confirmed from live capture: real retry receipts carry error="1"
							// in the overwhelming majority of samples (1270/1273); "0" never observed.
							error: '1'
						}
					},
					{
						tag: 'registration',
						attrs: {},
						content: (0, Utils_1.encodeBigEndian)(authState.creds.registrationId)
					}
				]
			}
			if (node.attrs.recipient) {
				receipt.attrs.recipient = node.attrs.recipient
			}
			if (node.attrs.participant) {
				receipt.attrs.participant = node.attrs.participant
			}
			if (retryCount > 1 || forceIncludeKeys || shouldRecreateSession) {
				const { update, preKeys } = await (0, Utils_1.getNextPreKeys)(authState, 1)
				const [keyId] = Object.keys(preKeys)
				const key = preKeys[+keyId]
				const content = receipt.content
				content.push({
					tag: 'keys',
					attrs: {},
					content: [
						{ tag: 'type', attrs: {}, content: Buffer.from(Defaults_1.KEY_BUNDLE_TYPE) },
						{ tag: 'identity', attrs: {}, content: identityKey.public },
						(0, Utils_1.xmppPreKey)(key, +keyId),
						(0, Utils_1.xmppSignedPreKey)(signedPreKey),
						{ tag: 'device-identity', attrs: {}, content: deviceIdentity }
					]
				})
				ev.emit('creds.update', update)
			}
			await sendNode(receipt)
			logger.info({ msgAttrs: node.attrs, retryCount }, 'sent retry receipt')
		}, authState?.creds?.me?.id || 'sendRetryRequest')
	}
	/**
	 * Fire-and-forget tctoken re-issuance after a peer's device identity changed.
	 * Runs in parallel with the session refresh (not after it).
	 */
	const reissueTcTokenAfterIdentityChange = from => {
		void (async () => {
			const normalizedJid = (0, WABinary_1.jidNormalizedUser)(from)
			const tcJid = await (0, tc_token_utils_1.resolveTcTokenJid)(normalizedJid, getLIDForPN)
			const tcTokenData = await authState.keys.get('tctoken', [tcJid])
			const senderTs = tcTokenData?.[tcJid]?.senderTimestamp
			if (senderTs == null || (0, tc_token_utils_1.isTcTokenExpired)(senderTs)) {
				return
			}
			logger.debug({ jid: normalizedJid, senderTimestamp: senderTs }, 'identity changed, re-issuing tctoken')
			const getPNForLID = signalRepository.lidMapping.getPNForLID.bind(signalRepository.lidMapping)
			const issueJid = await (0, tc_token_utils_1.resolveIssuanceJid)(
				normalizedJid,
				sock.serverProps.lidTrustedTokenIssueToLid,
				getLIDForPN,
				getPNForLID
			)
			const result = await issuePrivacyTokens([issueJid], senderTs)
			await (0, tc_token_utils_1.storeTcTokensFromIqResult)({
				result,
				fallbackJid: tcJid,
				keys: authState.keys,
				getLIDForPN,
				onNewJidStored: trackTcTokenJid
			})
		})().catch(err => {
			logger.debug({ jid: from, err: err?.message }, 'failed to re-issue tctoken after identity change')
		})
	}
	const handleEncryptNotification = async node => {
		const from = node.attrs.from
		if (from === WABinary_1.S_WHATSAPP_NET) {
			const countChild = (0, WABinary_1.getBinaryNodeChild)(node, 'count')
			const count = +countChild.attrs.value
			const shouldUploadMorePreKeys = count < Defaults_1.MIN_PREKEY_COUNT
			logger.debug({ count, shouldUploadMorePreKeys }, 'recv pre-key count')
			if (shouldUploadMorePreKeys) {
				await uploadPreKeys()
			}
		} else {
			const result = await (0, Utils_1.handleIdentityChange)(node, {
				meId: authState.creds.me?.id,
				meLid: authState.creds.me?.lid,
				validateSession: signalRepository.validateSession,
				assertSessions,
				debounceCache: identityAssertDebounce,
				logger,
				onBeforeSessionRefresh: reissueTcTokenAfterIdentityChange
			})
			if (result.action === 'no_identity_node') {
				logger.info({ node }, 'unknown encrypt notification')
			}
		}
	}
	// Group participant nodes carry authoritative LID<->PN pairs (jid + phone_number/lid
	// attrs). Persist them so PN<->LID resolution elsewhere doesn't need a usync round trip.
	const storeParticipantLidPairs = participants => {
		const pairs = []
		for (const p of participants || []) {
			if (p.phoneNumber) pairs.push({ lid: p.id, pn: p.phoneNumber })
			else if (p.lid) pairs.push({ lid: p.lid, pn: p.id })
		}
		if (!pairs.length) return
		signalRepository.lidMapping
			.storeLIDPNMappings(pairs)
			.catch(error => logger.debug({ error }, 'failed to store LID/PN mappings from group notification'))
	}
	const handleGroupNotification = (fullNode, child, msg) => {
		// PN/LID: acting + affected participant already resolved below via participant_pn/lid attrs
		const actingParticipantLid = fullNode.attrs.participant
		const actingParticipantPn = fullNode.attrs.participant_pn
		const actingParticipantUsername = fullNode.attrs.participant_username
		const affectedParticipantLid =
			(0, WABinary_1.getBinaryNodeChild)(child, 'participant')?.attrs?.jid || actingParticipantLid
		const affectedParticipantPn =
			(0, WABinary_1.getBinaryNodeChild)(child, 'participant')?.attrs?.phone_number || actingParticipantPn
		switch (child?.tag) {
			case 'create':
				const metadata = (0, groups_1.extractGroupMetadata)(child)
				msg.messageStubType = Types_1.WAMessageStubType.GROUP_CREATE
				msg.messageStubParameters = [metadata.subject]
				msg.key = { participant: metadata.owner, participantAlt: metadata.ownerPn }
				storeParticipantLidPairs(metadata.participants)
				ev.emit('chats.upsert', [
					{
						id: metadata.id,
						name: metadata.subject,
						conversationTimestamp: metadata.creation
					}
				])
				ev.emit('groups.upsert', [
					{
						...metadata,
						author: actingParticipantLid,
						authorPn: actingParticipantPn,
						authorUsername: actingParticipantUsername
					}
				])
				break
			case 'ephemeral':
			case 'not_ephemeral':
				msg.message = {
					protocolMessage: {
						type: index_js_1.proto.Message.ProtocolMessage.Type.EPHEMERAL_SETTING,
						ephemeralExpiration: +(child.attrs.expiration || 0)
					}
				}
				break
			case 'modify':
				const oldNumber = (0, WABinary_1.getBinaryNodeChildren)(child, 'participant').map(p => p.attrs.jid)
				msg.messageStubParameters = oldNumber || []
				msg.messageStubType = Types_1.WAMessageStubType.GROUP_PARTICIPANT_CHANGE_NUMBER
				break
			case 'promote':
			case 'demote':
			case 'remove':
			case 'add':
			case 'leave':
				const stubType = `GROUP_PARTICIPANT_${child.tag.toUpperCase()}`
				msg.messageStubType = Types_1.WAMessageStubType[stubType]
				const participants = (0, WABinary_1.getBinaryNodeChildren)(child, 'participant').map(({ attrs }) => {
					return {
						id: attrs.jid,
						phoneNumber:
							(0, WABinary_1.isLidUser)(attrs.jid) && (0, WABinary_1.isPnUser)(attrs.phone_number)
								? attrs.phone_number
								: undefined,
						lid: (0, WABinary_1.isPnUser)(attrs.jid) && (0, WABinary_1.isLidUser)(attrs.lid) ? attrs.lid : undefined,
						username: attrs.participant_username || attrs.username || undefined,
						admin: attrs.type || null,
						uuid: attrs.uuid || attrs.participant_uuid || undefined
					}
				})
				if (
					participants.length === 1 &&
					// if recv. "remove" message and sender removed themselves
					// mark as left
					((0, WABinary_1.areJidsSameUser)(participants[0].id, actingParticipantLid) ||
						(0, WABinary_1.areJidsSameUser)(participants[0].id, actingParticipantPn)) &&
					child.tag === 'remove'
				) {
					msg.messageStubType = Types_1.WAMessageStubType.GROUP_PARTICIPANT_LEAVE
				}
				storeParticipantLidPairs(participants)
				msg.messageStubParameters = participants.map(a => JSON.stringify(a))
				break
			case 'subject':
				msg.messageStubType = Types_1.WAMessageStubType.GROUP_CHANGE_SUBJECT
				msg.messageStubParameters = [child.attrs.subject]
				break
			case 'description':
				const description = (0, WABinary_1.getBinaryNodeChild)(child, 'body')?.content?.toString()
				msg.messageStubType = Types_1.WAMessageStubType.GROUP_CHANGE_DESCRIPTION
				msg.messageStubParameters = description ? [description] : undefined
				break
			case 'announcement':
			case 'not_announcement':
				msg.messageStubType = Types_1.WAMessageStubType.GROUP_CHANGE_ANNOUNCE
				msg.messageStubParameters = [child.tag === 'announcement' ? 'on' : 'off']
				break
			case 'locked':
			case 'unlocked':
				msg.messageStubType = Types_1.WAMessageStubType.GROUP_CHANGE_RESTRICT
				msg.messageStubParameters = [child.tag === 'locked' ? 'on' : 'off']
				break
			case 'invite':
				msg.messageStubType = Types_1.WAMessageStubType.GROUP_CHANGE_INVITE_LINK
				msg.messageStubParameters = [child.attrs.code]
				break
			case 'member_add_mode':
				const addMode = child.content
				if (addMode) {
					msg.messageStubType = Types_1.WAMessageStubType.GROUP_MEMBER_ADD_MODE
					msg.messageStubParameters = [addMode.toString()]
				}
				break
			case 'membership_approval_mode':
				const approvalMode = (0, WABinary_1.getBinaryNodeChild)(child, 'group_join')
				if (approvalMode) {
					msg.messageStubType = Types_1.WAMessageStubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_MODE
					msg.messageStubParameters = [approvalMode.attrs.state]
				}
				break
			case 'created_membership_requests':
				msg.messageStubType = Types_1.WAMessageStubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_REQUEST_NON_ADMIN_ADD
				msg.messageStubParameters = [
					JSON.stringify({ lid: affectedParticipantLid, pn: affectedParticipantPn }),
					'created',
					child.attrs.request_method
				]
				break
			case 'revoked_membership_requests':
				const isDenied = (0, WABinary_1.areJidsSameUser)(affectedParticipantLid, actingParticipantLid)
				if ((0, WABinary_1.isLidUser)(affectedParticipantLid) && (0, WABinary_1.isPnUser)(affectedParticipantPn)) {
					storeParticipantLidPairs([{ id: affectedParticipantLid, phoneNumber: affectedParticipantPn }])
				}
				msg.messageStubType = Types_1.WAMessageStubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_REQUEST_NON_ADMIN_ADD
				msg.messageStubParameters = [
					JSON.stringify({ lid: affectedParticipantLid, pn: affectedParticipantPn }),
					isDenied ? 'revoked' : 'rejected'
				]
				break
			case 'sibling_link': {
				const linkedGroupJid = (0, WABinary_1.getBinaryNodeChild)(child, 'group')?.attrs?.jid || child.attrs?.jid
				ev.emit('groups.update', [
					{
						id: fullNode.attrs.from,
						siblingGroupLinked: linkedGroupJid || true,
						author: actingParticipantLid,
						authorPn: actingParticipantPn
					}
				])
				break
			}
			case 'sibling_unlink': {
				const unlinkedGroupJid = (0, WABinary_1.getBinaryNodeChild)(child, 'group')?.attrs?.jid || child.attrs?.jid
				ev.emit('groups.update', [
					{
						id: fullNode.attrs.from,
						siblingGroupUnlinked: unlinkedGroupJid || true,
						author: actingParticipantLid,
						authorPn: actingParticipantPn
					}
				])
				break
			}
			case 'clear_history': {
				const historyClearTimestamp = child.attrs?.t ? +child.attrs.t : (0, Date)()
				ev.emit('groups.update', [
					{
						id: fullNode.attrs.from,
						historyClearTimestamp,
						author: actingParticipantLid,
						authorPn: actingParticipantPn
					}
				])
				break
			}
		}
	}
	const normalizeNotificationParticipant = async (jid, groupData) => {
		if (!jid || typeof jid !== 'string') {
			return jid
		}
		if (!(0, WABinary_1.isLidUser)(jid) && !(0, WABinary_1.isHostedLidUser)(jid)) {
			return jid
		}
		const normalized = await (0, jid_display_normalization_1.normalizeMentionedJidsForSend)(
			[jid],
			groupData,
			signalRepository,
			logger
		)
		return normalized?.[0] || jid
	}
	const normalizeNotificationParticipantsArray = async (participants, groupData) => {
		if (!Array.isArray(participants)) {
			return participants
		}
		return Promise.all(participants.map(jid => normalizeNotificationParticipant(jid, groupData)))
	}
	const getNotificationGroupData = async node => {
		const groupJid = (0, WABinary_1.jidNormalizedUser)(node?.attrs?.from)
		if (!(0, WABinary_1.isJidGroup)(groupJid)) {
			return undefined
		}
		try {
			return (
				(config.useCachedGroupMetadata && config.cachedGroupMetadata
					? await config.cachedGroupMetadata(groupJid)
					: undefined) || (await sock.groupMetadata(groupJid))
			)
		} catch (error) {
			logger.debug({ error, groupJid }, 'failed to fetch group metadata for notification normalization')
			return undefined
		}
	}
	const normalizeNotificationStubParameters = async (stubParameters, groupData) => {
		if (!Array.isArray(stubParameters)) {
			return stubParameters
		}
		const normalized = []
		for (const entry of stubParameters) {
			if (typeof entry !== 'string') {
				normalized.push(entry)
				continue
			}
			if ((0, WABinary_1.isLidUser)(entry) || (0, WABinary_1.isHostedLidUser)(entry)) {
				normalized.push(await normalizeNotificationParticipant(entry, groupData))
				continue
			}
			if (entry.startsWith('{') && entry.includes('"id"')) {
				try {
					const parsed = JSON.parse(entry)
					const explicitPn =
						typeof parsed?.phoneNumber === 'string'
							? parsed.phoneNumber
							: typeof parsed?.pn === 'string'
								? parsed.pn
								: undefined
					if ((0, WABinary_1.isPnUser)(explicitPn) || (0, WABinary_1.isHostedPnUser)(explicitPn)) {
						parsed.id = explicitPn
						parsed.pn = explicitPn
						normalized.push(JSON.stringify(parsed))
						continue
					}
					if (parsed?.id) {
						parsed.id = await normalizeNotificationParticipant(parsed.id, groupData)
					}
					if (parsed?.lid && !parsed?.pn) {
						parsed.pn = await normalizeNotificationParticipant(parsed.lid, groupData)
					}
					normalized.push(JSON.stringify(parsed))
					continue
				} catch (err) {
					logger.debug({ err, entry }, 'failed to normalize stub parameter JSON')
				}
			}
			normalized.push(entry)
		}
		return normalized
	}
	const normalizeCallEventJids = async (call, infoChild) => {
		if (!call) {
			return call
		}
		const callContextGroupJid = call.groupJid || ((0, WABinary_1.isJidGroup)(call.chatId) ? call.chatId : undefined)
		let groupData
		if (callContextGroupJid) {
			try {
				groupData =
					(config.useCachedGroupMetadata && config.cachedGroupMetadata
						? await config.cachedGroupMetadata(callContextGroupJid)
						: undefined) || (await sock.groupMetadata(callContextGroupJid))
			} catch (error) {
				logger.debug({ error, groupJid: callContextGroupJid }, 'failed to fetch group metadata for call normalization')
			}
		}
		if (call.chatId && !call.isGroup) {
			call.chatId = await normalizeNotificationParticipant(call.chatId, groupData)
		}
		if (call.from) {
			call.from = await normalizeNotificationParticipant(call.from, groupData)
		}
		if (call.groupJid) {
			call.groupJid = await normalizeNotificationParticipant(call.groupJid, groupData)
		}
		if (!call.callerPn && infoChild?.attrs?.caller_lid) {
			call.callerPn = await normalizeNotificationParticipant(infoChild.attrs.caller_lid, groupData)
		}
		if (!call.callerPn && call.from) {
			call.callerPn = call.from
		}
		return call
	}
	const normalizeNotificationResult = async (node, result, groupData) => {
		const groupJid = (0, WABinary_1.jidNormalizedUser)(node?.attrs?.from)
		if (!(0, WABinary_1.isJidGroup)(groupJid)) {
			return
		}
		if (result?.key?.participant) {
			result.key.participant = await normalizeNotificationParticipant(result.key.participant, groupData)
		}
		if (result?.participant) {
			result.participant = await normalizeNotificationParticipant(result.participant, groupData)
		}
		if (Array.isArray(result?.messageStubParameters)) {
			result.messageStubParameters = await normalizeNotificationStubParameters(result.messageStubParameters, groupData)
		}
	}

	/**
	 * Handle incoming interop notifications (type="interop").
	 *
	 * The APK emits these for:
	 *  - stella_interop_enabled / stella_ios_enabled  → feature-flag toggles
	 *  - ig_professional / ig_handle / followers       → Instagram profile data updates
	 *  - fbid:thread / fbid:devices                   → Meta thread/device association
	 *  - peer_device_presence                         → interop contact online/offline
	 *  - group membership changes in interop groups   → add/remove/promote events
	 */
	const handleInteropNotification = (node, child) => {
		const childTag = child?.tag
		const attrs = child?.attrs || {}

		// Feature flag: server toggled stella_interop_enabled or stella_ios_enabled
		if (childTag === 'feature') {
			const feature = attrs.name
			const enabled = attrs.value === 'true' || attrs.value === '1'
			logger.info({ feature, enabled }, '[interop] feature flag update')
			ev.emit('interop.feature-update', { feature, enabled })
			return
		}

		// Instagram profile data pushed for an interop contact
		if (childTag === 'ig_profile') {
			const contactUpdate = {
				id: (0, WABinary_1.jidNormalizedUser)(node.attrs.from),
				...(attrs.ig_handle ? { igHandle: attrs.ig_handle } : {}),
				...(attrs.ig_professional !== undefined ? { igProfessional: attrs.ig_professional === 'true' } : {}),
				...(attrs.followers !== undefined ? { igFollowers: parseInt(attrs.followers, 10) } : {})
			}
			logger.debug({ contactUpdate }, '[interop] ig_profile update')
			ev.emit('contacts.update', [contactUpdate])
			return
		}

		// peer_device_presence — interop contact came online or went offline
		if (childTag === 'peer_device_presence') {
			const jid = attrs.jid || (0, WABinary_1.jidNormalizedUser)(node.attrs.from)
			const presence = attrs.type === 'unavailable' ? 'unavailable' : 'available'
			const isIosInterop = !!authState.creds.interopIosEnabled
			logger.debug({ jid, presence, isIosInterop }, '[interop] peer_device_presence')
			ev.emit('presence.update', { id: jid, presences: { [jid]: { lastKnownPresence: presence } }, isIosInterop })
			return
		}

		// fbid:thread / fbid:devices — Meta thread or device list association
		if (childTag === 'fbid_thread' || childTag === 'fbid_devices') {
			const isIosInterop = !!authState.creds.interopIosEnabled
			logger.debug({ childTag, attrs, from: node.attrs.from, isIosInterop }, '[interop] fbid association update')
			ev.emit('interop.fbid-update', { type: childTag, jid: node.attrs.from, attrs, isIosInterop })
			return
		}

		// Interop group membership changes (add / remove / promote / demote)
		if (childTag === 'participants') {
			const groupJid = node.attrs.from
			const action = attrs.type // 'add' | 'remove' | 'promote' | 'demote'
			const participants = (0, WABinary_1.getBinaryNodeChildren)(child, 'participant').map(p => p.attrs.jid)
			logger.info({ groupJid, action, participants }, '[interop] group participants update')
			ev.emit('group-participants.update', { id: groupJid, participants, action })
			return
		}

		logger.debug({ childTag, from: node.attrs.from }, '[interop] unhandled interop notification subtype')
	}

	const processNotification = async node => {
		const result = {}
		const [child] = (0, WABinary_1.getAllBinaryNodeChildren)(node)
		const nodeType = node.attrs.type
		const from = (0, WABinary_1.jidNormalizedUser)(node.attrs.from)
		switch (nodeType) {
			case 'newsletter':
				await handleNewsletterNotification(node)
				break
			case 'mex':
				await handleMexNotification(node)
				break
			case 'w:gp2':
				if (child?.tag === 'groups_dirty') {
					// Bulk "these groups are stale, refetch" signal — not a per-group stub message,
					// so it doesn't go through handleGroupNotification (which assumes a single group).
					const dirtyGroupJids = (0, WABinary_1.getBinaryNodeChildren)(child, 'group')
						.map(g => g.attrs.jid)
						.filter(Boolean)
					if (dirtyGroupJids.length) {
						ev.emit(
							'groups.update',
							dirtyGroupJids.map(jid => ({ id: jid }))
						)
					}
					break
				}
				// PN/LID resolution for participant fields happens below via normalizeNotificationResult
				const groupData = await getNotificationGroupData(node)
				handleGroupNotification(node, child, result)

				await normalizeNotificationResult(node, result, groupData)
				break
			case 'mediaretry':
				const event = (0, Utils_1.decodeMediaRetryNode)(node)
				ev.emit('messages.media-update', [event])
				break
			case 'encrypt':
				await handleEncryptNotification(node)
				break
			case 'devices': {
				// child = <add> or <remove> — neither carries jid/lid, owner is node.attrs.from.
				// A third variant, <update hash="..."/>, carries no device list at all (just a
				// device-list hash refresh) — don't misreport it as "removed nothing".
				const addNode = (0, WABinary_1.getBinaryNodeChild)(node, 'add')
				const removeNode = (0, WABinary_1.getBinaryNodeChild)(node, 'remove')
				const changedNode = addNode || removeNode
				if (!changedNode) {
					logger.debug({ node }, 'devices hash refresh, no add/remove list to report')
					break
				}
				const isAdded = !!addNode
				const devices = (0, WABinary_1.getBinaryNodeChildren)(changedNode, 'device')
				const deviceOwnerJid = from
				const deviceData = devices.map(d => ({
					id: d.attrs.jid,
					lid: d.attrs.lid,
					// wire attr is "key-index" (hyphen), not "key_index"
					keyIndex: d.attrs['key-index'] ? +d.attrs['key-index'] : undefined,
					platform: d.attrs.platform || undefined,
					isCompanion: d.attrs.companion === 'true' || undefined
				}))
				const isSelf =
					(0, WABinary_1.areJidsSameUser)(from, authState.creds.me?.id) ||
					(0, WABinary_1.areJidsSameUser)(from, authState.creds.me?.lid)
				if (isSelf) {
					logger.info({ deviceData, isAdded }, 'my own devices changed')
				}
				if (deviceOwnerJid) {
					ev.emit('devices.update', { id: deviceOwnerJid, devices: deviceData, isSelf, added: isAdded })
				}
				break
			}
			case 'server_sync':
				const update = (0, WABinary_1.getBinaryNodeChild)(node, 'collection')
				if (update) {
					const name = update.attrs.name
					await resyncAppState([name], false)
				}
				break
			case 'picture': {
				const setPicture = (0, WABinary_1.getBinaryNodeChild)(node, 'set')
				const delPicture = (0, WABinary_1.getBinaryNodeChild)(node, 'delete')
				const pictureOwnerJid = (0, WABinary_1.jidNormalizedUser)(node?.attrs?.from)
				if (!pictureOwnerJid) {
					// a picture content hash is not a valid contact id — nothing usable to emit without "from"
					logger.debug({ node }, 'picture notification missing "from", skipping contacts.update')
					break
				}
				ev.emit('contacts.update', [
					{
						id: pictureOwnerJid,
						imgUrl: setPicture ? 'changed' : 'removed'
					}
				])
				if ((0, WABinary_1.isJidGroup)(from)) {
					const node = setPicture || delPicture
					result.messageStubType = Types_1.WAMessageStubType.GROUP_CHANGE_ICON
					if (setPicture) {
						result.messageStubParameters = [setPicture.attrs.id]
					}
					result.participant = node?.attrs.author
					result.key = {
						...(result.key || {}),
						participant: setPicture?.attrs.author
					}
				}
				break
			}
			case 'account_sync':
				if (child.tag === 'disappearing_mode') {
					const newDuration = +child.attrs.duration
					const timestamp = +child.attrs.t
					logger.info({ newDuration }, 'updated account disappearing mode')
					ev.emit('creds.update', {
						accountSettings: {
							...authState.creds.accountSettings,
							defaultDisappearingMode: {
								ephemeralExpiration: newDuration,
								ephemeralSettingTimestamp: timestamp
							}
						}
					})
				} else if (child.tag === 'blocklist') {
					// Real wire shape is <blocklist action="modify" addressing_mode="lid"/> with
					// no per-entry children — it's a "your blocklist changed, go refetch it" signal,
					// not an inline diff. Re-fetch and let fetchBlocklist emit the refreshed list.
					sock.fetchBlocklist().catch(error => logger.warn({ error }, 'failed to refresh blocklist after account_sync'))
				} else if (child.tag === 'devices') {
					// Full device-list sync: all linked devices + signed key-index-list.
					// Sent when a device is added, removed, or key index changes.
					const dhash = child.attrs.dhash
					const deviceNodes = (0, WABinary_1.getBinaryNodeChildren)(child, 'device')
					const keyIndexListNode = (0, WABinary_1.getBinaryNodeChild)(child, 'key-index-list')
					const devices = deviceNodes.map(d => ({
						jid: d.attrs.jid ? String(d.attrs.jid) : undefined,
						keyIndex: d.attrs['key-index'] ? +d.attrs['key-index'] : undefined
					}))
					logger.info({ dhash, deviceCount: devices.length }, 'account devices list synced')
					ev.emit('account.devices-synced', {
						dhash,
						devices,
						keyIndexListTimestamp: keyIndexListNode?.attrs?.ts ? +keyIndexListNode.attrs.ts : undefined,
						keyIndexList: keyIndexListNode?.content ? Buffer.from(keyIndexListNode.content) : undefined
					})
				}
				break
			case 'disappearing_mode': {
				// Same payload as the account_sync-nested variant above, but WhatsApp also
				// pushes it as its own top-level notification type on some accounts.
				const newDuration = +child.attrs.duration
				const timestamp = +child.attrs.t
				logger.info({ newDuration }, 'updated account disappearing mode')
				ev.emit('creds.update', {
					accountSettings: {
						...authState.creds.accountSettings,
						defaultDisappearingMode: {
							ephemeralExpiration: newDuration,
							ephemeralSettingTimestamp: timestamp
						}
					}
				})
				break
			}
			case 'contacts': {
				// <update jid="..."/> = single contact touched; <update hash="..."/> or a
				// sibling <sync after="..."/> = list-level signal with no actionable jid.
				const updateChild = (0, WABinary_1.getBinaryNodeChild)(node, 'update')
				if (updateChild?.attrs?.jid) {
					ev.emit('contacts.update', [{ id: (0, WABinary_1.jidNormalizedUser)(updateChild.attrs.jid) }])
				} else {
					logger.debug({ node }, 'contacts list changed (hash/sync signal), no per-contact jid to update')
				}
				break
			}
			case 'business':
				if (child?.tag === 'privacy') {
					// SMB privacy / data-sharing settings sync push
					ev.emit('business.privacy-settings-sync', {
						jid: from,
						categories: (0, WABinary_1.getBinaryNodeChildren)(child, 'category').map(c => ({
							name: c.attrs.name,
							value: c.attrs.value
						})),
						attrs: child.attrs
					})
				} else if (child?.tag === 'profile') {
					// Business profile updated for a contact (tag = profile version hash)
					ev.emit('contacts.update', [
						{
							id: (0, WABinary_1.jidNormalizedUser)(child.attrs.jid || from),
							businessProfileTag: child.attrs.tag
						}
					])
				} else if (child?.tag === 'verified_name') {
					// Verified business name changed — content is a proto payload
					ev.emit('contacts.update', [
						{
							id: (0, WABinary_1.jidNormalizedUser)(child.attrs.jid || from),
							verifiedName: {
								verifiedLevel: child.attrs.verified_level,
								serial: child.attrs.serial,
								version: child.attrs.v
							}
						}
					])
				} else if (child?.tag === 'remove') {
					// Business account downgraded/removed. <remove jid="..."/> names the account;
					// <remove hash="..."/> is a list-level signal with no actionable jid.
					if (child.attrs.jid) {
						ev.emit('contacts.update', [{ id: (0, WABinary_1.jidNormalizedUser)(child.attrs.jid), isBusiness: false }])
					}
				}
				break
			case 'hosted':
				// Coexistence (WhatsApp <-> Messenger/Instagram) onboarding/offboarding push
				// (WhatsApp Web: WASmaxInCoexistenceOnboarding/OffboardingNotification)
				if (child?.tag === 'onboarding_status') {
					ev.emit('coexistence.update', {
						jid: from,
						kind: 'onboarding',
						status: child.attrs.status,
						productSurface: child.attrs['product_surface']
					})
				} else if (child?.tag === 'offboarding') {
					ev.emit('coexistence.update', {
						jid: from,
						kind: 'offboarding',
						productSurface: child.attrs['product_surface']
					})
				}
				break
			case 'link_code_companion_reg':
				const linkCodeCompanionReg = (0, WABinary_1.getBinaryNodeChild)(node, 'link_code_companion_reg')
				const ref = toRequiredBuffer(
					(0, WABinary_1.getBinaryNodeChildBuffer)(linkCodeCompanionReg, 'link_code_pairing_ref')
				)
				const primaryIdentityPublicKey = toRequiredBuffer(
					(0, WABinary_1.getBinaryNodeChildBuffer)(linkCodeCompanionReg, 'primary_identity_pub')
				)
				const primaryEphemeralPublicKeyWrapped = toRequiredBuffer(
					(0, WABinary_1.getBinaryNodeChildBuffer)(
						linkCodeCompanionReg,
						'link_code_pairing_wrapped_primary_ephemeral_pub'
					)
				)
				const codePairingPublicKey = await decipherLinkPublicKey(primaryEphemeralPublicKeyWrapped)
				const companionSharedKey = Utils_1.Curve.sharedKey(
					authState.creds.pairingEphemeralKeyPair.private,
					codePairingPublicKey
				)
				const random = (0, crypto_1.randomBytes)(32)
				const linkCodeSalt = (0, crypto_1.randomBytes)(32)
				const linkCodePairingExpanded = (0, Utils_1.hkdf)(companionSharedKey, 32, {
					salt: linkCodeSalt,
					info: 'link_code_pairing_key_bundle_encryption_key'
				})
				const encryptPayload = Buffer.concat([
					Buffer.from(authState.creds.signedIdentityKey.public),
					primaryIdentityPublicKey,
					random
				])
				const encryptIv = (0, crypto_1.randomBytes)(12)
				const encrypted = (0, Utils_1.aesEncryptGCM)(
					encryptPayload,
					linkCodePairingExpanded,
					encryptIv,
					Buffer.alloc(0)
				)
				const encryptedPayload = Buffer.concat([linkCodeSalt, encryptIv, encrypted])
				const identitySharedKey = Utils_1.Curve.sharedKey(
					authState.creds.signedIdentityKey.private,
					primaryIdentityPublicKey
				)
				const identityPayload = Buffer.concat([companionSharedKey, identitySharedKey, random])
				authState.creds.advSecretKey = Buffer.from(
					(0, Utils_1.hkdf)(identityPayload, 32, { info: 'adv_secret' })
				).toString('base64')
				await query({
					tag: 'iq',
					attrs: {
						to: WABinary_1.S_WHATSAPP_NET,
						type: 'set',
						id: sock.generateMessageTag(),
						xmlns: 'md'
					},
					content: [
						{
							tag: 'link_code_companion_reg',
							attrs: {
								jid: authState.creds.me.id,
								stage: 'companion_finish'
							},
							content: [
								{
									tag: 'link_code_pairing_wrapped_key_bundle',
									attrs: {},
									content: encryptedPayload
								},
								{
									tag: 'companion_identity_public',
									attrs: {},
									content: authState.creds.signedIdentityKey.public
								},
								{
									tag: 'link_code_pairing_ref',
									attrs: {},
									content: ref
								}
							]
						}
					]
				})
				authState.creds.registered = true
				ev.emit('creds.update', authState.creds)
				break
			case 'privacy_token':
				await handlePrivacyTokenNotification(node)
				break
			case 'security':
				// Security notifications (compromised session, location change alerts)
				const securityType = child?.tag || node.attrs.type
				const securityData = {
					type: securityType,
					jid: from,
					timestamp: node.attrs.t ? +node.attrs.t : Math.floor(Date.now() / 1000),
					details: child?.attrs || {}
				}
				logger.warn({ securityData }, 'received security notification')
				ev.emit('security.alert', securityData)
				break
			case 'identity':
				// Identity change notifications — peer changed their identity key
				const identityJid = node.attrs.from
				const identityNewKey = child?.content ? Buffer.from(child.content) : undefined
				ev.emit('identity.update', {
					jid: (0, WABinary_1.jidNormalizedUser)(identityJid),
					newIdentityKey: identityNewKey,
					timestamp: node.attrs.t ? +node.attrs.t : Math.floor(Date.now() / 1000)
				})
				break
			case 'server':
				// Server-issued notifications (config changes, client config refresh)
				const serverTag = child?.tag
				if (serverTag === 'config') {
					const configData = {}
					for (const attr of Object.keys(child?.attrs || {})) {
						configData[attr] = child.attrs[attr]
					}
					ev.emit('server.config', configData)
				} else if (serverTag === 'app_state_key') {
					// Server pushed a new app-state key — trigger resync
					logger.info('server pushed app state key update')
					await resyncAppState(['critical_block', 'regular_high', 'regular_low'], false)
				} else {
					logger.debug({ node }, 'unhandled server notification')
				}
				break
			case 'status':
				// Contact status (about) change notification
				const statusOwner = node.attrs.from
				const statusText = child?.content ? child.content.toString() : undefined
				if (statusOwner && statusText !== undefined) {
					ev.emit('contacts.update', [
						{
							id: (0, WABinary_1.jidNormalizedUser)(statusOwner),
							status: statusText
						}
					])
				}
				break
			case 'usync':
				// USync result push from server
				const usyncResults = (0, WABinary_1.getBinaryNodeChildren)(child || node, 'user')
				if (usyncResults.length) {
					const updates = usyncResults
						.map(u => ({
							id: (0, WABinary_1.jidNormalizedUser)(u.attrs.jid),
							...(u.attrs.lid ? { lid: u.attrs.lid } : {}),
							...(u.attrs.username ? { username: u.attrs.username } : {}),
							...(u.attrs.status ? { status: u.attrs.status } : {})
						}))
						.filter(u => u.id)
					if (updates.length) {
						ev.emit('contacts.update', updates)
					}
				}
				break
			case 'interop':
				// Interop-related server notifications — covers:
				//   stella_interop_enabled / stella_ios_enabled feature flags
				//   ig_professional / ig_handle / followers (Instagram account data)
				//   fbid:thread / fbid:devices (Meta thread/device references)
				//   peer_device_presence updates
				//   group membership changes in interop groups
				handleInteropNotification(node, child)
				break
		}
		if (Object.keys(result).length) {
			return result
		}
	}
	/**
	 * In-memory cache of storage JIDs with stored tctokens, seeded from the persisted index.
	 * Used to coalesce writes during a session; pruning always re-reads the persisted index.
	 */
	const tcTokenKnownJids = new Set()
	const tcTokenIndexLoaded = (async () => {
		try {
			const jids = await (0, tc_token_utils_1.readTcTokenIndex)(authState.keys)
			for (const jid of jids) tcTokenKnownJids.add(jid)
			logger.debug({ count: tcTokenKnownJids.size }, 'loaded tctoken index')
		} catch (err) {
			logger.warn({ err: err?.message }, 'failed to load tctoken index')
		}
	})()
	let tcTokenIndexTimer
	async function flushTcTokenIndex() {
		if (tcTokenIndexTimer) {
			clearTimeout(tcTokenIndexTimer)
			tcTokenIndexTimer = undefined
		}
		const write = await (0, tc_token_utils_1.buildMergedTcTokenIndexWrite)(authState.keys, tcTokenKnownJids)
		return authState.keys.set({ tctoken: write })
	}
	function scheduleTcTokenIndexSave() {
		if (tcTokenIndexTimer) {
			clearTimeout(tcTokenIndexTimer)
		}
		tcTokenIndexTimer = setTimeout(() => {
			tcTokenIndexTimer = undefined
			flushTcTokenIndex().catch(err => {
				logger.warn({ err: err?.message }, 'failed to save tctoken index')
			})
		}, 5000)
	}
	function trackTcTokenJid(jid) {
		if (jid && jid !== tc_token_utils_1.TC_TOKEN_INDEX_KEY && !tcTokenKnownJids.has(jid)) {
			tcTokenKnownJids.add(jid)
			scheduleTcTokenIndexSave()
		}
	}
	const handlePrivacyTokenNotification = async node => {
		const tokensNode = (0, WABinary_1.getBinaryNodeChild)(node, 'tokens')
		if (!tokensNode) return
		const from = (0, WABinary_1.jidNormalizedUser)(node.attrs.from)
		// WA Web uses: senderLid ?? toLid(from) for the storage key
		const senderLid =
			node.attrs.sender_lid && (0, WABinary_1.isLidUser)((0, WABinary_1.jidNormalizedUser)(node.attrs.sender_lid))
				? (0, WABinary_1.jidNormalizedUser)(node.attrs.sender_lid)
				: undefined
		const fallbackJid = senderLid ?? (await (0, tc_token_utils_1.resolveTcTokenJid)(from, getLIDForPN))
		logger.debug({ from, storageJid: fallbackJid }, 'processing privacy token notification')
		await (0, tc_token_utils_1.storeTcTokensFromIqResult)({
			result: node,
			fallbackJid,
			keys: authState.keys,
			getLIDForPN,
			onNewJidStored: trackTcTokenJid
		})
	}
	async function decipherLinkPublicKey(data) {
		const buffer = toRequiredBuffer(data)
		const salt = buffer.slice(0, 32)
		const secretKey = await (0, Utils_1.derivePairingCodeKey)(authState.creds.pairingCode, salt)
		const iv = buffer.slice(32, 48)
		const payload = buffer.slice(48, 80)
		return (0, Utils_1.aesDecryptCTR)(payload, secretKey, iv)
	}
	function toRequiredBuffer(data) {
		if (data === undefined) {
			throw new boom_1.Boom('Invalid buffer', { statusCode: 400 })
		}
		return data instanceof Buffer ? data : Buffer.from(data)
	}
	const willSendMessageAgain = async (id, participant) => {
		const key = `${id}:${participant}`
		const retryCount = (await msgRetryCache.get(key)) || 0
		return retryCount < maxMsgRetryCount
	}
	const updateSendMessageAgainCount = async (id, participant) => {
		const key = `${id}:${participant}`
		const newValue = ((await msgRetryCache.get(key)) || 0) + 1
		await msgRetryCache.set(key, newValue)
	}
	const sendMessagesAgain = async (key, ids, retryNode) => {
		const remoteJid = key.remoteJid
		const participant = key.participant || remoteJid
		const retryCount = +retryNode.attrs.count || 1
		// Try to get messages from cache first, then fallback to getMessage
		const msgs = []
		for (const id of ids) {
			let msg
			// Try to get from retry cache first if enabled
			if (messageRetryManager) {
				const cachedMsg = messageRetryManager.getRecentMessage(remoteJid, id)
				if (cachedMsg) {
					msg = cachedMsg.message
					logger.debug({ jid: remoteJid, id }, 'found message in retry cache')
					// Mark retry as successful since we found the message
					messageRetryManager.markRetrySuccess(id)
				}
			}
			// Fallback to getMessage if not found in cache
			if (!msg) {
				msg = await getMessage({ ...key, id })
				if (msg) {
					logger.debug({ jid: remoteJid, id }, 'found message via getMessage')
					// Also mark as successful if found via getMessage
					if (messageRetryManager) {
						messageRetryManager.markRetrySuccess(id)
					}
				}
			}
			msgs.push(msg)
		}
		// if it's the primary jid sending the request
		// just re-send the message to everyone
		// prevents the first message decryption failure
		const sendToAll = !(0, WABinary_1.jidDecode)(participant)?.device
		// Check if we should recreate session for this retry
		let shouldRecreateSession = false
		let recreateReason = ''
		if (enableAutoSessionRecreation && messageRetryManager && retryCount > 1) {
			try {
				const sessionId = signalRepository.jidToSignalProtocolAddress(participant)
				const hasSession = await signalRepository.validateSession(participant)
				const result = messageRetryManager.shouldRecreateSession(participant, hasSession.exists)
				shouldRecreateSession = result.recreate
				recreateReason = result.reason
				if (shouldRecreateSession) {
					logger.debug({ participant, retryCount, reason: recreateReason }, 'recreating session for outgoing retry')
					await authState.keys.set({ session: { [sessionId]: null } })
				}
			} catch (error) {
				logger.warn({ error, participant }, 'failed to check session recreation for outgoing retry')
			}
		}
		await assertSessions([participant], true)
		if ((0, WABinary_1.isJidGroup)(remoteJid)) {
			await authState.keys.set({ 'sender-key-memory': { [remoteJid]: null } })
		}
		logger.debug({ participant, sendToAll, shouldRecreateSession, recreateReason }, 'forced new session for retry recp')
		for (const [i, msg] of msgs.entries()) {
			if (!ids[i]) continue
			if (msg && (await willSendMessageAgain(ids[i], participant))) {
				await updateSendMessageAgainCount(ids[i], participant)
				const msgRelayOpts = { messageId: ids[i] }
				if (sendToAll) {
					msgRelayOpts.useUserDevicesCache = false
				} else {
					msgRelayOpts.participant = {
						jid: participant,
						count: +retryNode.attrs.count
					}
				}
				await relayMessage(key.remoteJid, msg, msgRelayOpts)
			} else {
				logger.debug({ jid: key.remoteJid, id: ids[i] }, 'recv retry request, but message not available')
			}
		}
	}
	const handleReceipt = async node => {
		const { attrs, content } = node
		const isLid = attrs.from.includes('lid')
		const isNodeFromMe = (0, WABinary_1.areJidsSameUser)(
			attrs.participant || attrs.from,
			isLid ? authState.creds.me?.lid : authState.creds.me?.id
		)
		const remoteJid = !isNodeFromMe || (0, WABinary_1.isJidGroup)(attrs.from) ? attrs.from : attrs.recipient
		const fromMe = !attrs.recipient || ((attrs.type === 'retry' || attrs.type === 'sender') && isNodeFromMe)
		const key = {
			remoteJid,
			id: '',
			fromMe,
			participant: attrs.participant
		}
		if (shouldIgnoreJid(remoteJid) && remoteJid !== WABinary_1.S_WHATSAPP_NET) {
			logger.debug({ remoteJid }, 'ignoring receipt from jid')
			await sendMessageAck(node)
			return
		}
		const ids = [attrs.id]
		if (Array.isArray(content)) {
			const items = (0, WABinary_1.getBinaryNodeChildren)(content[0], 'item')
			ids.push(...items.map(i => i.attrs.id))
		}
		// E. Media Retry Notification Receipt
		// Server tells us a specific message's media should be re-fetched
		if (attrs.type === 'media-retry') {
			const mediaRetryNode =
				(0, WABinary_1.getBinaryNodeChild)(node, 'media-retry') ||
				(0, WABinary_1.getBinaryNodeChild)(node, 'media_retry')
			ev.emit('messages.media-retry', {
				ids,
				from: attrs.from,
				participant: attrs.participant,
				t: attrs.t,
				retryAttrs: mediaRetryNode?.attrs
			})
			await sendMessageAck(node).catch(ackErr => logger.error({ ackErr }, 'failed to ack media-retry receipt'))
			return
		}
		// F. Server Error Receipt
		// Server signals a delivery error for one or more messages
		if (attrs.type === 'server-error') {
			const errorNode = (0, WABinary_1.getBinaryNodeChild)(node, 'error')
			ev.emit('messages.server-error', {
				ids,
				from: attrs.from,
				participant: attrs.participant,
				t: attrs.t,
				errorCode: errorNode?.attrs?.code || attrs.error_code,
				errorText: errorNode?.attrs?.text || errorNode?.content?.toString?.()
			})
			await sendMessageAck(node).catch(ackErr => logger.error({ ackErr }, 'failed to ack server-error receipt'))
			return
		}
		// D. Receipt aggregation
		// Server sent a batched-receipt (receipt_agg attr) — emit dedicated event AND fall through
		// to the normal status-update pipeline so all IDs in the batch get their status updated.
		if (attrs.receipt_agg) {
			ev.emit('receipt.batched', {
				ids,
				from: attrs.from,
				participant: attrs.participant,
				type: attrs.type,
				t: attrs.t,
				receiptAgg: attrs.receipt_agg
			})
			// Do not return — let all IDs be processed by the normal receipt path below.
		}
		try {
			await Promise.all([
				receiptMutex.mutex(async () => {
					const status = (0, Utils_1.getStatusFromReceiptType)(attrs.type)
					if (
						typeof status !== 'undefined' &&
						// basically, we only want to know when a message from us has been delivered to/read by the other person
						// or another device of ours has read some messages
						(status >= index_js_1.proto.WebMessageInfo.Status.SERVER_ACK || !isNodeFromMe)
					) {
						if ((0, WABinary_1.isJidGroup)(remoteJid) || (0, WABinary_1.isJidStatusBroadcast)(remoteJid)) {
							if (attrs.participant) {
								const updateKey =
									status === index_js_1.proto.WebMessageInfo.Status.DELIVERY_ACK ? 'receiptTimestamp' : 'readTimestamp'
								ev.emit(
									'message-receipt.update',
									ids.map(id => ({
										key: { ...key, id },
										receipt: {
											userJid: (0, WABinary_1.jidNormalizedUser)(attrs.participant),
											[updateKey]: +attrs.t
										}
									}))
								)
							}
						} else {
							ev.emit(
								'messages.update',
								ids.map(id => ({
									key: { ...key, id },
									update: { status, messageTimestamp: (0, Utils_1.toNumber)(+(attrs.t ?? 0)) }
								}))
							)
						}
					}
					if (attrs.type === 'retry') {
						// correctly set who is asking for the retry
						key.participant = key.participant || attrs.from
						const retryNode = (0, WABinary_1.getBinaryNodeChild)(node, 'retry')
						if (ids[0] && key.participant && (await willSendMessageAgain(ids[0], key.participant))) {
							if (key.fromMe) {
								try {
									await updateSendMessageAgainCount(ids[0], key.participant)
									logger.debug({ attrs, key }, 'recv retry request')
									await sendMessagesAgain(key, ids, retryNode)
								} catch (error) {
									logger.error(
										{ key, ids, trace: error instanceof Error ? error.stack : 'Unknown error' },
										'error in sending message again'
									)
								}
							} else {
								logger.info({ attrs, key }, 'recv retry for not fromMe message')
							}
						} else {
							logger.info({ attrs, key }, 'will not send message again, as sent too many times')
						}
					}
				})
			])
		} finally {
			await sendMessageAck(node).catch(ackErr => logger.error({ ackErr }, 'failed to ack receipt'))
		}
	}
	const handleNotification = async node => {
		const remoteJid = node.attrs.from
		if (shouldIgnoreJid(remoteJid) && remoteJid !== WABinary_1.S_WHATSAPP_NET) {
			logger.debug({ remoteJid, id: node.attrs.id }, 'ignored notification')
			await sendMessageAck(node)
			return
		}
		try {
			await Promise.all([
				notificationMutex.mutex(async () => {
					const msg = await processNotification(node)
					if (msg) {
						const fromMe = (0, WABinary_1.areJidsSameUser)(node.attrs.participant || remoteJid, authState.creds.me.id)
						const { senderAlt: participantAlt, addressingMode } = (0, Utils_1.extractAddressingContext)(node)
						msg.key = {
							remoteJid,
							fromMe,
							participant: node.attrs.participant,
							participantAlt,
							participantUsername: node.attrs.participant_username,
							addressingMode,
							id: node.attrs.id,
							...(msg.key || {})
						}
						msg.participant ?? (msg.participant = node.attrs.participant)
						msg.messageTimestamp = +node.attrs.t
						let groupDataForNormalization
						if ((0, WABinary_1.isJidGroup)(msg?.key?.remoteJid)) {
							try {
								groupDataForNormalization =
									(config.useCachedGroupMetadata && config.cachedGroupMetadata
										? await config.cachedGroupMetadata(msg.key.remoteJid)
										: undefined) || (await sock.groupMetadata(msg.key.remoteJid))
							} catch (error) {
								logger.debug(
									{ error, jid: msg.key.remoteJid },
									'failed to fetch group metadata for recv jid normalization'
								)
							}
						}
						await (0, jid_display_normalization_1.normalizeMessageForDisplayJids)(
							msg,
							signalRepository,
							logger,
							groupDataForNormalization
						)
						const fullMsg = index_js_1.proto.WebMessageInfo.fromObject(msg)
						await upsertMessage(fullMsg, 'append')
					}
				})
			])
		} finally {
			await sendMessageAck(node).catch(ackErr => logger.error({ ackErr }, 'failed to ack notification'))
		}
	}
	const handleMessage = async node => {
		const isInteropNode = (0, WABinary_1.isInteropUser)(node.attrs.from)
		if (isInteropNode) {
			logger.info(
				{
					from: node.attrs.from,
					id: node.attrs.id,
					type: node.attrs.type,
					sts: node.attrs.sts,
					display_name: node.attrs.display_name,
					encType: (0, WABinary_1.getBinaryNodeChild)(node, 'enc')?.attrs?.type
				},
				'[interop] node arrived'
			)
		}
		if (shouldIgnoreJid(node.attrs.from) && node.attrs.from !== WABinary_1.S_WHATSAPP_NET) {
			if (isInteropNode) logger.warn({ from: node.attrs.from }, '[interop] node dropped by shouldIgnoreJid')
			logger.debug({ key: node.attrs.key }, 'ignored message')
			await sendMessageAck(node, Utils_1.NACK_REASONS.UnhandledError)
			return
		}
		const groupJid = node.attrs.from
		const communityJid = linkedParentMap[groupJid]
		const encNode = (0, WABinary_1.getBinaryNodeChild)(node, 'enc')
		// TODO: temporary fix for crashes and issues resulting of failed msmsg decryption
		if (encNode?.attrs.type === 'msmsg') {
			// await sendMessageAck(node, Utils_1.NACK_REASONS.MissingMessageSecret)
			// return
			// Pre-populate botMessageSecrets from store so msmsg can be decrypted after restart
			if (getMessage) {
				const metaNode = (0, WABinary_1.getBinaryNodeChild)(node, 'meta')
				const targetId = metaNode?.attrs?.target_id
				if (targetId) {
					try {
						const targetMsg = await getMessage({ remoteJid: node.attrs.from, id: targetId, fromMe: true })
						const secret = targetMsg?.messageContextInfo?.messageSecret
						if (secret) {
							;(0, Utils_1.setBotMessageSecret)(targetId, secret)
						}
					} catch (err) {
						logger.debug({ err, targetId }, 'failed to retrieve message secret for msmsg')
					}
				}
			}
		}
		let acked = false
		try {
			const {
				fullMessage: msg,
				category,
				author,
				decrypt
			} = (0, Utils_1.decryptMessageNode)(
				node,
				authState.creds.me.id,
				authState.creds.me.lid || '',
				signalRepository,
				logger
			)
			if (isInteropNode) {
				logger.info(
					{ remoteJid: msg.key.remoteJid, id: msg.key.id, fromMe: msg.key.fromMe, pushName: msg.pushName },
					'[interop] decodeMessageNode OK'
				)
			}
			const alt = msg.key.participantAlt || msg.key.remoteJidAlt
			// store new mappings we didn't have before
			if (!!alt) {
				const altServer = (0, WABinary_1.jidDecode)(alt)?.server
				const primaryJid = msg.key.participant || msg.key.remoteJid
				if (altServer === 'lid') {
					if (!(await signalRepository.lidMapping.getPNForLID(alt))) {
						await signalRepository.lidMapping.storeLIDPNMappings([{ lid: alt, pn: primaryJid }])
						await signalRepository.migrateSession(primaryJid, alt)
					}
				} else {
					await signalRepository.lidMapping.storeLIDPNMappings([{ lid: primaryJid, pn: alt }])
					await signalRepository.migrateSession(alt, primaryJid)
				}
			}
			await messageMutex.mutex(async () => {
				await decrypt()
				if (isInteropNode) {
					const stubType = msg.messageStubType
					const stubText = msg.messageStubParameters?.[0]
					logger.info(
						{
							id: msg.key.id,
							hasMessage: !!msg.message,
							messageKeys: msg.message ? Object.keys(msg.message) : [],
							stubType,
							stubText
						},
						'[interop] decrypt() done'
					)
				}
				if (msg.key?.remoteJid && msg.key?.id && msg.message && messageRetryManager) {
					messageRetryManager.addRecentMessage(msg.key.remoteJid, msg.key.id, msg.message)
				}
				// message failed to decrypt
				if (msg.messageStubType === index_js_1.proto.WebMessageInfo.StubType.CIPHERTEXT && msg.category !== 'peer') {
					if (msg?.messageStubParameters?.[0] === Utils_1.MISSING_KEYS_ERROR_TEXT) {
						if (isInteropNode) logger.warn({ id: msg.key.id }, '[interop] decrypt failed: MISSING_KEYS')
						acked = true
						return sendMessageAck(node, Utils_1.NACK_REASONS.ParsingError)
					}
					if (msg.messageStubParameters?.[0] === Utils_1.NO_MESSAGE_FOUND_ERROR_TEXT) {
						// Message arrived without encryption (e.g. CTWA ads messages).
						// Check if this is eligible for placeholder resend (matching WA Web filters).
						const unavailableNode = (0, WABinary_1.getBinaryNodeChild)(node, 'unavailable')
						const unavailableType = unavailableNode?.attrs?.type
						if (
							unavailableType === 'bot_unavailable_fanout' ||
							unavailableType === 'hosted_unavailable_fanout' ||
							unavailableType === 'view_once_unavailable_fanout'
						) {
							logger.debug(
								{ msgId: msg.key.id, unavailableType },
								'skipping placeholder resend for excluded unavailable type'
							)
							acked = true
							return sendMessageAck(node)
						}
						const messageAge = (0, Utils_1.unixTimestampSeconds)() - (0, Utils_1.toNumber)(msg.messageTimestamp)
						if (messageAge > Defaults_1.PLACEHOLDER_MAX_AGE_SECONDS) {
							logger.debug({ msgId: msg.key.id, messageAge }, 'skipping placeholder resend for old message')
							acked = true
							return sendMessageAck(node)
						}
						// Request the real content from the phone via placeholder resend PDO.
						// Upsert the CIPHERTEXT stub as a placeholder (like WA Web's processPlaceholderMsg),
						// and store the requestId in stubParameters[1] so users can correlate
						// with the incoming PDO response event.
						const cleanKey = {
							remoteJid: msg.key.remoteJid,
							fromMe: msg.key.fromMe,
							id: msg.key.id,
							participant: msg.key.participant
						}
						// Cache the original message metadata so the PDO response handler
						// can preserve key fields (LID details etc.) that the phone may omit
						const msgData = {
							key: msg.key,
							messageTimestamp: msg.messageTimestamp,
							pushName: msg.pushName,
							participant: msg.participant,
							verifiedBizName: msg.verifiedBizName
						}
						requestPlaceholderResend(cleanKey, msgData)
							.then(requestId => {
								if (requestId && requestId !== 'RESOLVED') {
									logger.debug({ msgId: msg.key.id, requestId }, 'requested placeholder resend for unavailable message')
									ev.emit('messages.update', [
										{
											key: msg.key,
											update: { messageStubParameters: [Utils_1.NO_MESSAGE_FOUND_ERROR_TEXT, requestId] }
										}
									])
								}
							})
							.catch(err => {
								logger.warn({ err, msgId: msg.key.id }, 'failed to request placeholder resend for unavailable message')
							})
						acked = true
						await sendMessageAck(node)
						// Don't return — fall through to upsertMessage so the stub is emitted
					} else {
						// Skip retry for expired status messages (>24h old)
						if ((0, WABinary_1.isJidStatusBroadcast)(msg.key.remoteJid)) {
							const messageAge = (0, Utils_1.unixTimestampSeconds)() - (0, Utils_1.toNumber)(msg.messageTimestamp)
							if (messageAge > Defaults_1.STATUS_EXPIRY_SECONDS) {
								logger.debug(
									{ msgId: msg.key.id, messageAge, remoteJid: msg.key.remoteJid },
									'skipping retry for expired status message'
								)
								acked = true
								return sendMessageAck(node)
							}
						}
						const errorMessage = msg?.messageStubParameters?.[0] || ''
						const isPreKeyError = errorMessage.includes('PreKey')
						logger.debug(`[handleMessage] Attempting retry request for failed decryption`)
						// Handle both pre-key and normal retries in single mutex
						await retryMutex.mutex(async () => {
							try {
								if (!ws.isOpen) {
									logger.debug({ node }, 'Connection closed, skipping retry')
									return
								}
								// Handle pre-key errors with upload and delay
								if (isPreKeyError) {
									logger.info({ error: errorMessage }, 'PreKey error detected, uploading and retrying')
									try {
										logger.debug('Uploading pre-keys for error recovery')
										await uploadPreKeys(5)
										logger.debug('Waiting for server to process new pre-keys')
										await (0, Utils_1.delay)(1000)
									} catch (uploadErr) {
										logger.error({ uploadErr }, 'Pre-key upload failed, proceeding with retry anyway')
									}
								}
								const encNode = (0, WABinary_1.getBinaryNodeChild)(node, 'enc')
								await sendRetryRequest(node, !encNode)
								if (retryRequestDelayMs) {
									await (0, Utils_1.delay)(retryRequestDelayMs)
								}
							} catch (err) {
								logger.error({ err, isPreKeyError }, 'Failed to handle retry, attempting basic retry')
								// Still attempt retry even if pre-key upload failed
								try {
									const encNode = (0, WABinary_1.getBinaryNodeChild)(node, 'enc')
									await sendRetryRequest(node, !encNode)
								} catch (retryErr) {
									logger.error({ retryErr }, 'Failed to send retry after error handling')
								}
							}
							acked = true
							await sendMessageAck(node, Utils_1.NACK_REASONS.UnhandledError)
						})
					}
				} else {
					if (messageRetryManager && msg.key.id) {
						messageRetryManager.cancelPendingPhoneRequest(msg.key.id)
					}
					const isNewsletter = (0, WABinary_1.isJidNewsletter)(msg.key.remoteJid)
					if (!isNewsletter) {
						// no type in the receipt => message delivered
						let type = undefined
						let participant = msg.key.participant
						if (communityJid) {
							msg.communityJid = communityJid
						}
						if (category === 'peer') {
							// special peer message
							type = 'peer_msg'
						} else if (msg.key.fromMe) {
							// message was sent by us from a different device
							type = 'sender'
							// need to specially handle this case
							if ((0, WABinary_1.isLidUser)(msg.key.remoteJid) || (0, WABinary_1.isLidUser)(msg.key.remoteJidAlt)) {
								participant = author // TODO: investigate sending receipts to LIDs and not PNs
							}
						} else if (!sendActiveReceipts) {
							type = 'inactive'
						}
						acked = true
						// Pass sts from the original stanza for interop contacts (BirdyChat/Haiket)
						const interopSts = (0, WABinary_1.isInteropUser)(msg.key.remoteJid) ? node.attrs.sts : undefined
						await sendReceipt(msg.key.remoteJid, participant, [msg.key.id], type, interopSts)
						// send ack for history message
						const isAnyHistoryMsg = (0, Utils_1.getHistoryMsg)(msg.message)
						if (isAnyHistoryMsg) {
							const jid = (0, WABinary_1.jidNormalizedUser)(msg.key.remoteJid)
							await sendReceipt(jid, undefined, [msg.key.id], 'hist_sync') // TODO: investigate
						}
					} else {
						acked = true
						await sendMessageAck(node)
						logger.debug({ key: msg.key }, 'processed newsletter message without receipts')
					}
				}
				;(0, Utils_1.cleanMessage)(msg, authState.creds.me.id, authState.creds.me.lid)
				const msgTs = (0, Utils_1.toNumber)(msg.messageTimestamp)
				const isPending = !isConnected || node.attrs.offline || msgTs < socketCreatedAt
				if (isInteropNode) {
					logger.info(
						{
							id: msg.key.id,
							isPending,
							isConnected,
							offline: node.attrs.offline,
							msgTs,
							socketCreatedAt
						},
						isPending ? '[interop] upsert as append (pending/offline)' : '[interop] upsert as notify'
					)
				}
				if (isPending) {
					await upsertMessage(msg, 'append')
					return
				}
				let groupDataForNormalization
				if ((0, WABinary_1.isJidGroup)(msg?.key?.remoteJid)) {
					try {
						groupDataForNormalization =
							(config.useCachedGroupMetadata && config.cachedGroupMetadata
								? await config.cachedGroupMetadata(msg.key.remoteJid)
								: undefined) || (await sock.groupMetadata(msg.key.remoteJid))
					} catch (error) {
						logger.debug({ error, jid: msg.key.remoteJid }, 'failed to fetch group metadata for recv jid normalization')
					}
				}
				await (0, jid_display_normalization_1.normalizeMessageForDisplayJids)(
					msg,
					signalRepository,
					logger,
					groupDataForNormalization
				)
				await upsertMessage(msg, 'notify')
			})
		} catch (error) {
			if (isInteropNode) {
				logger.error(
					{ error: error?.message, stack: error?.stack, from: node.attrs.from, id: node.attrs.id },
					'[interop] unhandled error in handleMessage'
				)
			}
			logger.error({ error, node: (0, WABinary_1.binaryNodeToString)(node) }, 'error in handling message')
			if (!acked) {
				await sendMessageAck(node, Utils_1.NACK_REASONS.UnhandledError).catch(ackErr =>
					logger.error({ ackErr }, 'failed to ack message after error')
				)
			}
		}
	}
	// group_info roster: <group_info><user jid=.. state=.. user_pn=..><device jid=..
	// platform=..><capability ver=../></device></user>...</group_info>. Baileys previously
	// only kept the flat group_info-level attrs (call.payload), dropping the roster entirely.
	const parseGroupCallRoster = groupInfoNode =>
		(0, WABinary_1.getBinaryNodeChildren)(groupInfoNode, 'user').map(userNode => ({
			jid: userNode.attrs.jid,
			state: userNode.attrs.state,
			userPn: userNode.attrs.user_pn,
			devices: (0, WABinary_1.getBinaryNodeChildren)(userNode, 'device').map(d => ({
				jid: d.attrs.jid,
				platform: d.attrs.platform
			}))
		}))
	const handleCall = async node => {
		try {
			const { attrs } = node
			const [infoChild] = (0, WABinary_1.getAllBinaryNodeChildren)(node)
			if (!infoChild) {
				throw new boom_1.Boom('Missing call info in call node')
			}
			const status = (0, Utils_1.getCallStatusFromNode)(infoChild)
			const callId = infoChild.attrs['call-id']
			const from = infoChild.attrs.from || infoChild.attrs['call-creator']
			const call = {
				chatId: attrs.from,
				from,
				callerPn: infoChild.attrs['caller_pn'],
				id: callId,
				date: new Date(+attrs.t * 1000),
				offline: !!attrs.offline,
				status
			}
			if (status === 'relaylatency') {
				const latencyValue = infoChild.attrs.latency || infoChild.attrs['latency_ms'] || infoChild.attrs['latency-ms']
				const latencyMs = latencyValue ? Number(latencyValue) : undefined
				if (Number.isFinite(latencyMs)) {
					call.latencyMs = latencyMs
				}
			}
			if (status === 'offer') {
				const videoNode = (0, WABinary_1.getBinaryNodeChild)(infoChild, 'video')
				const audioNodes = (0, WABinary_1.getBinaryNodeChildren)(infoChild, 'audio')
				const silenceNode = (0, WABinary_1.getBinaryNodeChild)(infoChild, 'silence')
				call.isVideo = !!videoNode
				call.isGroup = infoChild.attrs.type === 'group' || !!infoChild.attrs['group-jid']
				call.groupJid = infoChild.attrs['group-jid']
				// lightweight=1 marks a silent/wave-style group ring (no full ringing UX expected)
				call.isLightweight = infoChild.attrs.lightweight === '1'
				if (silenceNode?.attrs?.reason) {
					call.silenceReason = silenceNode.attrs.reason
				}
				// Wire attrs are "enc"/"rate" (audio) and "dec" (video) — not "codec".
				// <audio> can repeat once per supported sample rate.
				if (audioNodes.length) {
					call.audioCodecs = audioNodes.map(n => ({ enc: n.attrs.enc, rate: n.attrs.rate ? +n.attrs.rate : undefined }))
					call.audioCodec = audioNodes[0].attrs.enc
				}
				if (videoNode?.attrs?.dec) {
					call.videoCodec = videoNode.attrs.dec
				}
				// Decrypt Signal-encrypted callKey from <enc> child
				const encNode = (0, WABinary_1.getBinaryNodeChild)(infoChild, 'enc')
				if (encNode?.content) {
					try {
						const encType = encNode.attrs.type || 'msg'
						const ciphertext = Buffer.isBuffer(encNode.content) ? encNode.content : Buffer.from(encNode.content)
						const decrypted = await signalRepository.decryptMessage({ jid: attrs.from, type: encType, ciphertext })
						const unpadded = (0, Utils_1.unpadRandomMax16)(decrypted)
						const callMsg = index_js_1.proto.Message.decode(unpadded)
						if (callMsg?.call?.callKey?.length) {
							call.callKey = Buffer.from(callMsg.call.callKey)
						}
					} catch (e) {
						logger.debug({ e }, 'failed to decrypt call enc')
					}
				}
				await callOfferCache.set(call.id, call)
			} else if (status === 'waiting_room_request') {
				call.peerJid = infoChild.attrs.from || infoChild.attrs['peer-jid'] || infoChild.attrs['user-jid']
			}
			const existingCall = await callOfferCache.get(call.id)
			// use existing call info to populate this event
			if (existingCall) {
				call.isVideo = existingCall.isVideo
				call.isGroup = existingCall.isGroup
				call.callerPn = call.callerPn || existingCall.callerPn
			}
			// Enrich event payload for signalling-only statuses
			if (status === 'peer_state') {
				const stateChild = (0, WABinary_1.getBinaryNodeChild)(infoChild, 'peer_state')
				call.state = stateChild?.attrs?.state || infoChild.attrs?.state
			} else if (status === 'group_info') {
				call.payload = infoChild.attrs
				call.participants = parseGroupCallRoster(infoChild)
			} else if (status === 'video_state') {
				const vsChild = (0, WABinary_1.getBinaryNodeChild)(infoChild, 'video_state')
				const enabledRaw = vsChild?.attrs?.enabled ?? infoChild.attrs?.enabled
				call.enabled = enabledRaw === 'true' || enabledRaw === '1'
			} else if (status === 'enc_rekey') {
				const rekeyChild =
					(0, WABinary_1.getBinaryNodeChild)(infoChild, 'enc-rekey') ||
					(0, WABinary_1.getBinaryNodeChild)(infoChild, 'enc_rekey')
				if (rekeyChild?.content && Buffer.isBuffer(rekeyChild.content)) {
					try {
						call.rekeyPayload = (0, Utils_1.decodeE2eRekeyPayload)(rekeyChild.content)
					} catch (e) {
						logger.debug({ e }, 'failed to decode enc-rekey payload in handleCall')
					}
				}
			}
			// delete data once call has ended
			if (
				status === 'reject' ||
				status === 'accept' ||
				status === 'timeout' ||
				status === 'terminate' ||
				status === 'reject_do_not_disturb' ||
				status === 'mic_permission_denied' ||
				status === 'camera_permission_denied' ||
				status === 'remote_busy' ||
				status === 'remote_offline'
			) {
				await callOfferCache.del(call.id)
			}
			await normalizeCallEventJids(call, infoChild)
			ev.emit('call', [call])
		} catch (error) {
			logger.error({ error, node: (0, WABinary_1.binaryNodeToString)(node) }, 'error in handling call')
		} finally {
			await sendMessageAck(node).catch(ackErr => logger.error({ ackErr }, 'failed to ack call'))
		}
	}
	// Some accounts receive call signalling as TOP-LEVEL stanzas (<offer>, <terminate>,
	// <mute_v2>, <transport>, … each with a call-id) instead of wrapped in <call>.
	// This additively handles those: emit a 'call' event for state stanzas and ack ALL
	// of them (otherwise WhatsApp keeps redelivering). The <call> path above is untouched.
	const CALL_STATE_TAGS = new Set([
		'offer',
		'offer_notice',
		'terminate',
		'accept',
		'reject',
		'preaccept',
		'accept_ack',
		'enc-rekey',
		'enc_rekey',
		'peer_state',
		'group_info',
		'video_state',
		'video_state_ack',
		'flow_control',
		'mute_v2',
		'waiting_room_request'
	])
	const handleStandaloneCallStanza = async node => {
		try {
			if (!CALL_STATE_TAGS.has(node.tag)) {
				return // media/relay signalling (transport, video, duration, mute_v2, lobby, …): ack only
			}
			const { attrs } = node
			const status = (0, Utils_1.getCallStatusFromNode)(node)
			const callId = attrs['call-id']
			const from = attrs.from || attrs['call-creator']
			const call = {
				chatId: attrs.from || from,
				from,
				callerPn: attrs['caller_pn'],
				id: callId,
				date: attrs.t ? new Date(+attrs.t * 1000) : new Date(),
				offline: !!attrs.offline,
				status
			}
			if (status === 'offer') {
				const videoNode = (0, WABinary_1.getBinaryNodeChild)(node, 'video')
				const audioNodes = (0, WABinary_1.getBinaryNodeChildren)(node, 'audio')
				const silenceNode = (0, WABinary_1.getBinaryNodeChild)(node, 'silence')
				call.isVideo = !!videoNode
				call.isGroup = attrs.type === 'group' || !!attrs['group-jid']
				call.groupJid = attrs['group-jid']
				call.isLightweight = attrs.lightweight === '1'
				if (silenceNode?.attrs?.reason) {
					call.silenceReason = silenceNode.attrs.reason
				}
				// Wire attrs are "enc"/"rate" (audio) and "dec" (video) — not "codec".
				if (audioNodes.length) {
					call.audioCodecs = audioNodes.map(n => ({ enc: n.attrs.enc, rate: n.attrs.rate ? +n.attrs.rate : undefined }))
					call.audioCodec = audioNodes[0].attrs.enc
				}
				if (videoNode?.attrs?.dec) {
					call.videoCodec = videoNode.attrs.dec
				}
				if (callId) {
					await callOfferCache.set(callId, call)
				}
			}
			const existingCall = callId ? await callOfferCache.get(callId) : undefined
			if (existingCall) {
				call.isVideo = existingCall.isVideo
				call.isGroup = existingCall.isGroup
				call.callerPn = call.callerPn || existingCall.callerPn
			}
			// Enrich event payload for signalling-only statuses
			if (status === 'peer_state') {
				const stateChild = (0, WABinary_1.getBinaryNodeChild)(node, 'peer_state')
				call.state = stateChild?.attrs?.state || attrs?.state
			} else if (status === 'group_info') {
				call.payload = attrs
				call.participants = parseGroupCallRoster(node)
			} else if (status === 'video_state') {
				const vsChild = (0, WABinary_1.getBinaryNodeChild)(node, 'video_state')
				const enabledRaw = vsChild?.attrs?.enabled ?? attrs?.enabled
				call.enabled = enabledRaw === 'true' || enabledRaw === '1'
			} else if (status === 'enc_rekey') {
				const rekeyChild =
					(0, WABinary_1.getBinaryNodeChild)(node, 'enc-rekey') || (0, WABinary_1.getBinaryNodeChild)(node, 'enc_rekey')
				if (rekeyChild?.content && Buffer.isBuffer(rekeyChild.content)) {
					try {
						call.rekeyPayload = (0, Utils_1.decodeE2eRekeyPayload)(rekeyChild.content)
					} catch (e) {
						logger.debug({ e }, 'failed to decode enc-rekey payload in standalone call stanza')
					}
				}
			} else if (status === 'mute') {
				// mute_v2 IS the top-level tag on real traffic (no wrapping/nested child) —
				// attrs are { call-id, call-creator, mute-state: "0"|"1" }, never
				// muted/audio_muted, and there's no nested <audio> child.
				call.muted = node.attrs['mute-state'] === '1'
			}
			if (
				callId &&
				(status === 'reject' ||
					status === 'accept' ||
					status === 'timeout' ||
					status === 'terminate' ||
					status === 'reject_do_not_disturb' ||
					status === 'mic_permission_denied' ||
					status === 'camera_permission_denied' ||
					status === 'remote_busy' ||
					status === 'remote_offline')
			) {
				await callOfferCache.del(callId)
			}
			await normalizeCallEventJids(call, node)
			ev.emit('call', [call])
		} catch (error) {
			logger.error({ error, node: (0, WABinary_1.binaryNodeToString)(node) }, 'error handling standalone call stanza')
		} finally {
			await sendMessageAck(node).catch(ackErr => logger.error({ ackErr }, 'failed to ack standalone call'))
		}
	}
	const handleBadAck = async ({ attrs }) => {
		const key = { remoteJid: attrs.from, fromMe: true, id: attrs.id }
		// WARNING: REFRAIN FROM ENABLING THIS FOR NOW. IT WILL CAUSE A LOOP
		// // current hypothesis is that if pash is sent in the ack
		// // it means -- the message hasn't reached all devices yet
		// // we'll retry sending the message here
		// if(attrs.phash) {
		// 	logger.info({ attrs }, 'received phash in ack, resending message...')
		// 	const msg = await getMessage(key)
		// 	if(msg) {
		// 		await relayMessage(key.remoteJid!, msg, { messageId: key.id!, useUserDevicesCache: false })
		// 	} else {
		// 		logger.warn({ attrs }, 'could not send message again, as it was not found')
		// 	}
		// }
		// error in acknowledgement,
		// device could not display the message
		if (attrs.error) {
			if (attrs.error === Utils_1.SERVER_ERROR_CODES.MissingTcToken) {
				// 463 = account restricted + no tctoken for this contact.
				// WA Web prevents this client-side (disables compose bar).
				// No retry — retrying worsens the restriction by counting as another "reach out" to an unknown contact.
				logger.warn(
					{ msgId: attrs.id, from: attrs.from },
					'error 463: account restricted or missing tctoken for contact'
				)
			} else if (attrs.error === Utils_1.SERVER_ERROR_CODES.SmaxInvalid) {
				logger.warn(
					{ msgId: attrs.id, from: attrs.from },
					'smax-invalid (479): stanza rejected by server — likely stale device session or malformed addressing'
				)
			} else {
				logger.warn({ attrs }, 'received error in ack')
			}
			ev.emit('messages.update', [
				{
					key,
					update: {
						status: Types_1.WAMessageStatus.ERROR,
						messageStubParameters: [attrs.error]
					}
				}
			])
			// resend the message with device_fanout=false, use at your own risk
			// if (attrs.error === '475') {
			// 	const msg = await getMessage(key)
			// 	if (msg) {
			// 		await relayMessage(key.remoteJid!, msg, {
			// 			messageId: key.id!,
			// 			useUserDevicesCache: false,
			// 			additionalAttributes: {
			// 				device_fanout: 'false'
			// 			}
			// 		})
			// 	}
			// }
		}
	}
	const handleChatstate = async node => {
		const { from, state } = node.attrs
		if (!from) return
		const isTyping = state === 'typing'
		ev.emit('presence.update', [
			{
				id: from,
				presences: {
					[from]: isTyping ? 'composing' : 'paused'
				}
			}
		])
	}
	const handlePresence = async node => {
		const { from, type } = node.attrs
		if (!from || !type) return
		const presenceMap = {
			available: 'available',
			unavailable: 'unavailable'
		}
		const presence = presenceMap[type] || type
		ev.emit('presence.update', [
			{
				id: from,
				presences: {
					[from]: presence
				},
				lastSeen: node.attrs.t ? Number(node.attrs.t) * 1000 : undefined
			}
		])
	}
	/// processes a node with the given function
	/// and adds the task to the existing buffer if we're buffering events
	const processNodeWithBuffer = async (node, identifier, exec) => {
		ev.buffer()
		await execTask()
		ev.flush()
		function execTask() {
			return exec(node, false).catch(err => onUnexpectedError(err, identifier))
		}
	}
	const offlineNodeProcessor = (0, offline_node_processor_1.makeOfflineNodeProcessor)(
		new Map([
			['message', handleMessage],
			['call', handleCall],
			['receipt', handleReceipt],
			['notification', handleNotification]
		]),
		{
			isWsOpen: () => ws.isOpen,
			onUnexpectedError,
			yieldToEventLoop: () => new Promise(resolve => setImmediate(resolve))
		}
	)
	const processNode = async (type, node, identifier, exec) => {
		const isOffline = !!node.attrs.offline
		if (isOffline) {
			offlineNodeProcessor.enqueue(type, node)
		} else {
			await processNodeWithBuffer(node, identifier, exec)
		}
	}
	let latestNodeInMemory = null
	const nodelogger = node => {
		if (!node) return null
		latestNodeInMemory = node
		return latestNodeInMemory
	}
	const setNodeLoggerListener = () => {
		return latestNodeInMemory
	}
	// recv a message
	ws.on('CB:message', async node => {
		nodelogger(node)
		await processNode('message', node, 'processing message', handleMessage)
	})
	ws.on('CB:call', async node => {
		nodelogger(node)
		await processNode('call', node, 'handling call', handleCall)
	})
	// additive: top-level call-signalling stanzas (some accounts send these instead of <call>)
	for (const callTag of [
		'offer',
		'offer_notice',
		'terminate',
		'accept',
		'reject',
		'preaccept',
		'accept_ack',
		'enc-rekey',
		'enc_rekey',
		'peer_state',
		'group_info',
		'video_state',
		'video_state_ack',
		'flow_control',
		'transport',
		'video',
		'duration',
		'mute_v2',
		'lobby',
		'heartbeat',
		'relaylatency',
		'link_query',
		'waiting_room_request',
		// Present in Utils/stanza-ack.js's CALL_STANZA_TAGS (ack builder already treats it as a
		// call stanza) but was missing here — meant it was never routed/acked, so real traffic
		// (confirmed via live capture) would just get redelivered forever.
		'group_update'
	]) {
		ws.on('CB:' + callTag, node => {
			nodelogger(node)
			handleStandaloneCallStanza(node).catch(error => onUnexpectedError(error, 'handling standalone call stanza'))
		})
	}
	ws.on('CB:receipt', async node => {
		nodelogger(node)
		await processNode('receipt', node, 'handling receipt', handleReceipt)
	})
	ws.on('CB:notification', async node => {
		nodelogger(node)
		await processNode('notification', node, 'handling notification', handleNotification)
	})
	ws.on('CB:status', async node => {
		nodelogger(node)
		await handleNewsletterStatus(node).catch(error => onUnexpectedError(error, 'handling newsletter status'))
	})
	ws.on('CB:chatstate', async node => {
		nodelogger(node)
		await handleChatstate(node).catch(error => onUnexpectedError(error, 'handling chatstate'))
	})
	ws.on('CB:presence', async node => {
		nodelogger(node)
		await handlePresence(node).catch(error => onUnexpectedError(error, 'handling presence'))
	})
	ws.on('CB:ack,class:message', node => {
		nodelogger(node)
		handleBadAck(node).catch(error => onUnexpectedError(error, 'handling bad ack'))
	})
	const linkedParentMap = {}
	ws.on('CB:iq', node => {
		if (node && node.tag === 'iq' && node.attrs.type === 'result') {
			const groups = node.content

			if (Array.isArray(groups)) {
				for (const group of groups) {
					const groupId = group.attrs.id + '@g.us'

					if (group && Array.isArray(group.content)) {
						for (const item of group.content) {
							if (item.tag === 'linked_parent' && item.attrs && item.attrs.jid) {
								linkedParentMap[groupId] = item.attrs.jid
							}
						}
					}
				}
			}
		}
	})
	ev.on('call', async ([call]) => {
		if (!call) {
			return
		}
		nodelogger(call)
		// missed call + group call notification message generation
		if (call.status === 'timeout' || (call.status === 'offer' && call.isGroup)) {
			const msg = {
				key: {
					remoteJid: call.chatId,
					id: call.id,
					fromMe: false
				},
				messageTimestamp: (0, Utils_1.unixTimestampSeconds)(call.date)
			}
			if (call.status === 'timeout') {
				if (call.isGroup) {
					msg.messageStubType = call.isVideo
						? Types_1.WAMessageStubType.CALL_MISSED_GROUP_VIDEO
						: Types_1.WAMessageStubType.CALL_MISSED_GROUP_VOICE
				} else {
					msg.messageStubType = call.isVideo
						? Types_1.WAMessageStubType.CALL_MISSED_VIDEO
						: Types_1.WAMessageStubType.CALL_MISSED_VOICE
				}
			} else {
				msg.message = { call: { callKey: Buffer.from(call.id) } }
			}
			const protoMsg = index_js_1.proto.WebMessageInfo.fromObject(msg)
			await upsertMessage(protoMsg, call.offline ? 'append' : 'notify')
		}
	})
	let lastTcTokenPruneTs = 0
	ev.on('connection.update', ({ isOnline, connection }) => {
		if (connection === 'open') {
			isConnected = true
		}
		if (typeof isOnline !== 'undefined') {
			sendActiveReceipts = isOnline
			logger.trace(`sendActiveReceipts set to "${sendActiveReceipts}"`)
		}
		// Daily cleanup of expired tctokens (mirrors WA Web's CLEAN_TC_TOKENS task)
		if (isOnline) {
			const now = Date.now()
			const DAY_MS = 24 * 60 * 60 * 1000
			if (now - lastTcTokenPruneTs >= DAY_MS) {
				lastTcTokenPruneTs = now
				void pruneExpiredTcTokens()
			}
		}
	})
	async function pruneExpiredTcTokens() {
		try {
			await tcTokenIndexLoaded
			const persisted = await (0, tc_token_utils_1.readTcTokenIndex)(authState.keys)
			const allJids = new Set(tcTokenKnownJids)
			for (const jid of persisted) allJids.add(jid)
			if (!allJids.size) return
			const jids = [...allJids]
			const allTokens = await authState.keys.get('tctoken', jids)
			const writes = {}
			const survivors = new Set()
			let mutated = 0
			for (const jid of jids) {
				const entry = allTokens[jid]
				if (!entry) {
					mutated++
					continue
				}
				const hasPeerToken = !!entry.token?.length
				const peerTokenExpired = hasPeerToken && (0, tc_token_utils_1.isTcTokenExpired)(entry.timestamp)
				const hasSenderTs = entry.senderTimestamp !== undefined
				const senderTsExpired = hasSenderTs && (0, tc_token_utils_1.isTcTokenExpired)(entry.senderTimestamp)
				const keepPeerToken = hasPeerToken && !peerTokenExpired
				const keepSenderTs = hasSenderTs && !senderTsExpired
				if (!keepPeerToken && !keepSenderTs) {
					writes[jid] = null
					mutated++
				} else if (peerTokenExpired && keepSenderTs) {
					writes[jid] = { token: Buffer.alloc(0), senderTimestamp: entry.senderTimestamp }
					survivors.add(jid)
					mutated++
				} else {
					survivors.add(jid)
				}
			}
			if (mutated === 0) return
			await authState.keys.set({
				tctoken: {
					...writes,
					[tc_token_utils_1.TC_TOKEN_INDEX_KEY]: {
						token: Buffer.from(JSON.stringify([...survivors]))
					}
				}
			})
			tcTokenKnownJids.clear()
			for (const jid of survivors) tcTokenKnownJids.add(jid)
			logger.debug({ mutated, remaining: survivors.size }, 'pruned expired tctokens')
		} catch (err) {
			logger.warn({ err: err?.message }, 'failed to prune expired tctokens')
		}
	}
	return {
		...sock,
		sendMessageAck,
		sendRetryRequest,
		offerCall,
		rejectCall,
		acceptCall,
		terminateCall,
		rekeyCall,
		joinCallLink,
		queryCallLink,
		nodelogger,
		setNodeLoggerListener,
		fetchMessageHistory,
		requestPlaceholderResend,
		requestWaffleNonce,
		requestCompanionCanonicalNonce,
		requestCompanionMetaNonce,
		messageRetryManager
	}
}
exports.makeMessagesRecvSocket = makeMessagesRecvSocket
