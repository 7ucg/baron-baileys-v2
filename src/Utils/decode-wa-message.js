'use strict'
Object.defineProperty(exports, '__esModule', { value: true })
exports.decryptMessageNode =
	exports.extractAddressingContext =
	exports.SERVER_ERROR_CODES =
	exports.NACK_REASONS =
	exports.DECRYPTION_RETRY_CONFIG =
	exports.MISSING_KEYS_ERROR_TEXT =
	exports.NO_MESSAGE_FOUND_ERROR_TEXT =
	exports.getDecryptionJid =
		void 0
exports.decodeMessageNode = decodeMessageNode
const boom_1 = require('@hapi/boom')
const WAProto_1 = require('../../WAProto/index.js')
const WABinary_1 = require('../WABinary')
const generics_1 = require('./generics')
const meta_ai_msmsg_1 = require('./meta-ai-msmsg')
const messages_1 = require('./messages')
const MAX_SECRETS_PER_CHAT = 20
// Module-level map: outgoing @bot message ID → messageSecret
// Populated when we receive the outgoing pkmsg/msg to @bot (which contains messageContextInfo.messageSecret)
// Consumed when the msmsg response from @bot arrives and needs decryption
const botMessageSecrets = new Map()
const botRecentSecretsByChat = new Map()
const pushRecentChatSecret = (chatJid, id, secretBuf) => {
	if (!chatJid || !secretBuf) return
	const existing = botRecentSecretsByChat.get(chatJid) || []
	const filtered = existing.filter(item => item.id !== id && !item.secret.equals(secretBuf))
	filtered.unshift({ id, secret: secretBuf })
	if (filtered.length > MAX_SECRETS_PER_CHAT) {
		filtered.length = MAX_SECRETS_PER_CHAT
	}
	botRecentSecretsByChat.set(chatJid, filtered)
}
const setBotMessageSecret = (id, secret, chatJid) => {
	if (!id || !secret) return
	let buf
	if (Buffer.isBuffer(secret)) {
		buf = secret
	} else if (secret instanceof Uint8Array) {
		buf = Buffer.from(secret.buffer, secret.byteOffset, secret.byteLength)
	} else if (typeof secret === 'string') {
		buf = Buffer.from(secret, 'base64')
	} else {
		return
	}
	botMessageSecrets.set(id, buf)
	if (chatJid) {
		pushRecentChatSecret(chatJid, id, buf)
	}
}
exports.setBotMessageSecret = setBotMessageSecret
const getDecryptionJid = async (sender, repository) => {
	if (
		(0, WABinary_1.isLidUser)(sender) ||
		(0, WABinary_1.isHostedLidUser)(sender) ||
		(0, WABinary_1.isInteropUser)(sender)
	) {
		// LID and interop JIDs are session keys themselves — no PN mapping lookup needed
		return sender
	}
	const mapped = await repository.lidMapping.getLIDForPN(sender)
	return mapped || sender
}
exports.getDecryptionJid = getDecryptionJid
const storeMappingFromEnvelope = async (stanza, sender, repository, decryptionJid, logger) => {
	const { senderAlt } = (0, exports.extractAddressingContext)(stanza)
	if (
		senderAlt &&
		((0, WABinary_1.isLidUser)(senderAlt) || (0, WABinary_1.isHostedLidUser)(senderAlt)) &&
		((0, WABinary_1.isPnUser)(sender) || (0, WABinary_1.isHostedPnUser)(sender)) &&
		decryptionJid === sender
	) {
		try {
			await repository.lidMapping.storeLIDPNMappings([{ lid: senderAlt, pn: sender }])
			await repository.migrateSession(sender, senderAlt)
			logger.debug({ sender, senderAlt }, 'Stored LID mapping from envelope')
		} catch (error) {
			logger.warn({ sender, senderAlt, error }, 'Failed to store LID mapping')
		}
	}
}
exports.NO_MESSAGE_FOUND_ERROR_TEXT = 'Message absent from node'
exports.MISSING_KEYS_ERROR_TEXT = 'Key used already or never filled'
/**
 * Server-side error codes returned in ack stanzas (server → client).
 * Distinct from the client-side NackReason enum.
 */
exports.SERVER_ERROR_CODES = {
	/** 1:1 message missing privacy token (tctoken) */
	MissingTcToken: '463',
	/** Stanza validation failure (SMAX_INVALID) — likely stale device session */
	SmaxInvalid: '479'
}
// Retry configuration for failed decryption
exports.DECRYPTION_RETRY_CONFIG = {
	maxRetries: 3,
	baseDelayMs: 100,
	sessionRecordErrors: ['No session record', 'SessionError: No session record']
}
exports.NACK_REASONS = {
	ParsingError: 487,
	UnrecognizedStanza: 488,
	UnrecognizedStanzaClass: 489,
	UnrecognizedStanzaType: 490,
	InvalidProtobuf: 491,
	InvalidHostedCompanionStanza: 493,
	MissingMessageSecret: 495,
	SignalErrorOldCounter: 496,
	MessageDeletedOnPeer: 499,
	UnhandledError: 500,
	UnsupportedAdminRevoke: 550,
	UnsupportedLIDGroup: 551,
	DBOperationFailed: 552
}
const extractAddressingContext = stanza => {
	let senderAlt
	let recipientAlt
	const sender = stanza.attrs.participant || stanza.attrs.from
	const addressingMode = stanza.attrs.addressing_mode || (sender?.endsWith('lid') ? 'lid' : 'pn')
	if (addressingMode === 'lid') {
		// Message is LID-addressed: sender is LID, extract corresponding PN
		// without device data
		senderAlt = stanza.attrs.participant_pn || stanza.attrs.sender_pn || stanza.attrs.peer_recipient_pn
		recipientAlt = stanza.attrs.recipient_pn
		// with device data
		//if (sender && senderAlt) senderAlt = transferDevice(sender, senderAlt)
	} else {
		// Message is PN-addressed: sender is PN, extract corresponding LID
		// without device data
		senderAlt = stanza.attrs.participant_lid || stanza.attrs.sender_lid || stanza.attrs.peer_recipient_lid
		recipientAlt = stanza.attrs.recipient_lid
		//with device data
		//if (sender && senderAlt) senderAlt = transferDevice(sender, senderAlt)
	}
	return {
		addressingMode,
		senderAlt,
		recipientAlt
	}
}
exports.extractAddressingContext = extractAddressingContext
/**
 * Decode the received node as a message.
 * @note this will only parse the message, not decrypt it
 */
function decodeMessageNode(stanza, meId, meLid) {
	let nodey = []
	let msgType
	let chatId
	let author
	let fromMe = false
for (const { tag, attrs, content } of stanza.content) {
const clean = v => {
  if (Array.isArray(v)) return v.map(clean);

  if (v && typeof v === "object") {
    const keys = Object.keys(v);

    if (
      keys.length &&
      keys.every(k => /^\d+$/.test(k))
    ) {
      return "[bytes]";
    }

    if (
      v.type === "Buffer" &&
      Array.isArray(v.data)
    ) {
      return "[bytes]";
    }

    return Object.fromEntries(
      Object.entries(v).map(([k, val]) => [k, clean(val)])
    );
  }

  return v;
}
if (tag !== "plaintext" && tag !== "enc") {
nodey.push(clean({
tag: tag,
attrs: attrs,
content: content
}))
}
}

	const msgId = stanza.attrs.id
	const from = stanza.attrs.from
	const participant = stanza.attrs.participant
	const recipient = stanza.attrs.recipient
	const addressingContext = (0, exports.extractAddressingContext)(stanza)
	const isMe = jid => (0, WABinary_1.areJidsSameUser)(jid, meId)
	const isMeLid = jid => (0, WABinary_1.areJidsSameUser)(jid, meLid)
	if (
		(0, WABinary_1.isPnUser)(from) ||
		(0, WABinary_1.isLidUser)(from) ||
		(0, WABinary_1.isHostedLidUser)(from) ||
		(0, WABinary_1.isHostedPnUser)(from)
	) {
		if (recipient) {
			if (!isMe(from) && !isMeLid(from)) {
				throw new boom_1.Boom('receipient present, but msg not from me', { data: stanza })
			}
			if (isMe(from) || isMeLid(from)) {
				fromMe = true
			}
			chatId = recipient
		} else {
			chatId = from
		}
		msgType = 'chat'
		author = from
	} else if ((0, WABinary_1.isJidGroup)(from)) {
		if (!participant) {
			throw new boom_1.Boom('No participant in group message')
		}
		if (isMe(participant) || isMeLid(participant)) {
			fromMe = true
		}
		msgType = 'group'
		author = participant
		chatId = from
	} else if ((0, WABinary_1.isJidBroadcast)(from)) {
		if (!participant) {
			throw new boom_1.Boom('No participant in group message')
		}
		const isParticipantMe = isMe(participant)
		if ((0, WABinary_1.isJidStatusBroadcast)(from)) {
			msgType = isParticipantMe ? 'direct_peer_status' : 'other_status'
		} else {
			msgType = isParticipantMe ? 'peer_broadcast' : 'other_broadcast'
		}
		fromMe = isParticipantMe
		chatId = from
		author = participant
	} else if ((0, WABinary_1.isJidMetaAI)(from)) {
		msgType = 'chat'
		chatId = from
		author = from
		fromMe = false
	} else if ((0, WABinary_1.isJidNewsletter)(from)) {
		msgType = 'newsletter'
		chatId = from
		author = from
		// if (isMe(from) || isMeLid(from)) {
		// 	fromMe = true
		// }

		fromMe = (0, WABinary_1.isJidNewsletter)(from)
			? !!stanza.attrs?.is_sender
			: (0, WABinary_1.isLidUser)(from)
				? (0, WABinary_1.areJidsSameUser)(from, meLid)
				: (0, WABinary_1.areJidsSameUser)(from, meId)
	} else if ((0, WABinary_1.isInteropUser)(from)) {
		// Message from an interop contact (Facebook Messenger / Instagram via WA bridge).
		// Treat as regular 1:1 chat — same Signal decrypt path as @s.whatsapp.net / @lid.
		msgType = 'chat'
		chatId = from
		author = from
		fromMe = false
	} else {
		throw new boom_1.Boom('Unknown message type', { data: stanza })
	}
	// Interop stanzas (BirdyChat/Haiket) use display_name instead of notify
	const pushname = stanza?.attrs?.notify ?? stanza?.attrs?.display_name
	const key = {
		remoteJid: chatId,
		remoteJidAlt: !(0, WABinary_1.isJidGroup)(chatId) ? addressingContext.senderAlt : undefined,
		remoteJidUsername: !(0, WABinary_1.isJidGroup)(chatId)
			? stanza.attrs.peer_recipient_username || stanza.attrs.recipient_username
			: undefined,
		fromMe,
		id: msgId,
		participant,
		participantAlt: (0, WABinary_1.isJidGroup)(chatId) ? addressingContext.senderAlt : undefined,
		participantUsername: stanza.attrs.participant ? stanza.attrs.participant_username : undefined,
		addressingMode: addressingContext.addressingMode,
		...(msgType === 'newsletter' && stanza.attrs.server_id ? { server_id: stanza.attrs.server_id } : {})
	}
	const fullMessage = {
		key,
		category: stanza.attrs.category,
		messageTimestamp: +stanza.attrs.t,
		pushName: pushname,
		broadcast: (0, WABinary_1.isJidBroadcast)(from),
		newsletter: (0, WABinary_1.isJidNewsletter)(from),
		StanzaAttrs: stanza.attrs,
		nodes: nodey,
		Owner: 'Baron' // Non-WhatsApp attribute

	}
	if (key.fromMe) {
		fullMessage.status = WAProto_1.proto.WebMessageInfo.Status.SERVER_ACK
	}
	if (msgType === 'newsletter') {
		fullMessage.newsletter_server_id = +stanza.attrs?.server_id
	}
	if (!key.fromMe) {
		fullMessage.platform = messages_1.getDevice(key.id)
	}
	return {
		fullMessage,
		author,
		sender: msgType === 'chat' ? author : chatId
	}
}
const decryptMessageNode = (stanza, meId, meLid, repository, logger) => {
	const { fullMessage, author, sender } = decodeMessageNode(stanza, meId, meLid)
	let metaTargetId = null
	let botEditTargetId = null
	let botType = null
	let metaTargetSenderJid = null
	return {
		fullMessage,
		category: stanza.attrs.category,
		author,
		async decrypt() {
			let decryptables = 0
			if (Array.isArray(stanza.content)) {
				let hasMsmsg = false
				for (const { attrs } of stanza.content) {
					if ((attrs === null || attrs === void 0 ? void 0 : attrs.type) === 'msmsg') {
						hasMsmsg = true
						break
					}
				}
				if (hasMsmsg) {
					for (const { tag, attrs } of stanza.content) {
						if (tag === 'meta' && attrs?.target_id) {
							metaTargetId = attrs.target_id
						}
						if (tag === 'meta' && attrs?.target_sender_jid) {
							metaTargetSenderJid = attrs.target_sender_jid
						}
						if (tag === 'bot' && attrs && 'edit_target_id' in attrs) {
							botEditTargetId = attrs.edit_target_id // Can be '' for 'first' type
						}
						if (tag === 'bot' && (attrs === null || attrs === void 0 ? void 0 : attrs.edit)) {
							botType = attrs.edit
						}
					}
				}

				// Process unicast enc nodes (pkmsg/msg) before group enc nodes (skmsg/frskmsg)
				// so that any SenderKeyDistributionMessage carried in a unicast is installed
				// before GroupCipher.decrypt() runs for frskmsg in the same stanza.
				const _isGroupEnc = n => n.tag === 'enc' && (n.attrs?.type === 'skmsg' || n.attrs?.type === 'frskmsg')
				const _stanzaContent = [
					...stanza.content.filter(n => !_isGroupEnc(n)),
					...stanza.content.filter(n => _isGroupEnc(n))
				]
				for (const { tag, attrs, content } of _stanzaContent) {
					if (tag === 'verified_name' && content instanceof Uint8Array) {
						const cert = WAProto_1.proto.VerifiedNameCertificate.decode(content)
						const details = WAProto_1.proto.VerifiedNameCertificate.Details.decode(cert.details)
						fullMessage.verifiedBizName = details.verifiedName
						// Extract verified level from node attrs (LOW / HIGH / UNKNOWN)
						if (attrs?.verified_level) {
							fullMessage.verifiedNameLevel = attrs.verified_level
						}
					}
					if (tag === 'unavailable' && attrs.type === 'view_once') {
						fullMessage.key.isViewOnce = true
						fullMessage.messageStubType = WAProto_1.proto.WebMessageInfo.StubType.VIEWED_ONCE
					}
					if (attrs.count && tag === 'enc') {
						fullMessage.retryCount = Number(attrs.count)
					}
					if (tag !== 'enc' && tag !== 'plaintext') {
						continue
					}
					if (!(content instanceof Uint8Array)) {
						continue
					}
					decryptables += 1
					let msgBuffer
					const decryptionJid = await (0, exports.getDecryptionJid)(author, repository)
					if (tag !== 'plaintext') {
						if ((0, WABinary_1.isHostedPnUser)(decryptionJid) || (0, WABinary_1.isHostedLidUser)(decryptionJid)) {
							fullMessage.isHostedDevice = true
						}
						await storeMappingFromEnvelope(stanza, author, repository, decryptionJid, logger)
					}
					try {
						const e2eType = tag === 'plaintext' ? 'plaintext' : attrs.type
						switch (e2eType) {
							case 'frskmsg':
							case 'skmsg':
								msgBuffer = await repository.decryptGroupMessage({
									group: sender,
									authorJid: author,
									msg: content
								})
								break

							case 'story_reply':
							case 'feed_reshare':
							case 'native_flow_response':
							case 'companion_enc_static':
							case 'avatar_sticker':
							case 'genai_sticker':
							case 'account_authentication_request':
							case 'motion_video':
							case 'motion_photo':
							case 'pkmsg':
							case 'msg': {
								const _unicastType =
									e2eType === 'story_reply' ||
									e2eType === 'feed_reshare' ||
									e2eType === 'native_flow_response' ||
									e2eType === 'companion_enc_static' ||
									e2eType === 'avatar_sticker' ||
									e2eType === 'genai_sticker' ||
									e2eType === 'account_authentication_request' ||
									e2eType === 'motion_video' ||
									e2eType === 'motion_photo'
										? 'msg'
										: e2eType
								msgBuffer = await repository.decryptMessage({
									jid: decryptionJid,
									type: _unicastType,
									ciphertext: content
								})
								break
							}
							case 'msmsg': //Message Secret Message
								// null = no bot node (non-streaming), 'full'/'last' = complete response
								// 'first' = streaming partial response, intentionally skipped
								if (botType !== null && !['full', 'last'].includes(botType)) break
								const secretIdCandidates = [botEditTargetId, metaTargetId, fullMessage.key?.id].filter(Boolean)
								const secretCandidates = []
								const seenSecrets = new Set()
								for (const idCandidate of secretIdCandidates) {
									const byId = botMessageSecrets.get(idCandidate)
									if (!byId) continue
									const fp = byId.toString('hex')
									if (!seenSecrets.has(fp)) {
										seenSecrets.add(fp)
										secretCandidates.push({ source: `id:${idCandidate}`, secret: byId })
									}
								}
								const chatRecent = botRecentSecretsByChat.get(sender) || []
								for (const item of chatRecent) {
									const fp = item.secret.toString('hex')
									if (!seenSecrets.has(fp)) {
										seenSecrets.add(fp)
										secretCandidates.push({ source: `chat:${item.id}`, secret: item.secret })
									}
									if (secretCandidates.length >= 6) break
								}
								if (!secretCandidates.length) {
									logger.warn(
										{ metaTargetId, botType, secretIdCandidates },
										'msmsg: no candidate messageSecret found, skipping'
									)
									break
								}
								{
									const msMsg = WAProto_1.proto.MessageSecretMessage.decode(content)
									const helperKey = {
										participant: author,
										meId: metaTargetSenderJid || `${meLid.split(`:`)[0]}@lid`,
										meLid,
										botEditTargetId,
										metaTargetId,
										stanzaId: stanza.attrs?.id
									}
									let decryptErr
									for (const candidate of secretCandidates) {
										try {
											msgBuffer = await (0, meta_ai_msmsg_1.decryptMsmsgBotMessage)(candidate.secret, helperKey, msMsg)
											logger.debug({ source: candidate.source }, 'msmsg: decrypted with candidate secret')
											break
										} catch (e) {
											decryptErr = e
										}
									}
									if (!msgBuffer && decryptErr) {
										logger.warn(
											{
												secretCandidateSources: secretCandidates.map(candidate => candidate.source),
												cause: decryptErr?.message
											},
											'msmsg: helper decryption failed for all candidate secrets'
										)
										throw decryptErr
									}
								}
								break
							case 'plaintext':
								msgBuffer = content
								break
							default:
								throw new Error(`Unknown e2e type: ${e2eType}`)
						}
						if (!msgBuffer) {
							continue
						}
						let msgToDecode
						if (e2eType === 'msmsg') {
							msgToDecode = null
						} else {
							msgToDecode = e2eType !== 'plaintext' ? (0, generics_1.unpadRandomMax16)(msgBuffer) : msgBuffer
						}
						let msg =
							e2eType === 'msmsg'
								? (0, meta_ai_msmsg_1.decodeDecryptedMsmsgMessage)(msgBuffer)
								: WAProto_1.proto.Message.decode(msgToDecode)
						const outerMessageContextInfo = msg.messageContextInfo
						msg = msg.deviceSentMessage?.message || msg
						// deviceSentMessage.message may not carry messageContextInfo (e.g. messageSecret for @bot)
						// even though the outer wrapper does — preserve it
						if (outerMessageContextInfo && !msg.messageContextInfo) {
							msg.messageContextInfo = outerMessageContextInfo
						}
						if (msg.senderKeyDistributionMessage) {
							//eslint-disable-next-line max-depth
							try {
								await repository.processSenderKeyDistributionMessage({
									authorJid: author,
									item: msg.senderKeyDistributionMessage
								})
							} catch (err) {
								logger.error({ key: fullMessage.key, err }, 'failed to process sender key distribution message')
							}
						}
						if (msg.fastRatchetKeySenderKeyDistributionMessage) {
							//eslint-disable-next-line max-depth
							try {
								await repository.processSenderKeyDistributionMessage({
									authorJid: author,
									item: msg.fastRatchetKeySenderKeyDistributionMessage
								})
							} catch (err) {
								logger.error(
									{ key: fullMessage.key, err },
									'failed to process fast ratchet sender key distribution message'
								)
							}
						}
						if (fullMessage.message) {
							Object.assign(fullMessage.message, msg)
						} else {
							fullMessage.message = msg
						}
						// --- story_reply metadata ---
						if (e2eType === 'story_reply') {
							fullMessage.storyReply = true
							// Secondary check: quoted status JID in the decoded message
							const quotedJid = msg.extendedTextMessage?.contextInfo?.remoteJid
							if (quotedJid && (0, WABinary_1.isJidStatusBroadcast)(quotedJid)) {
								fullMessage.storyReply = true
							}
						}
						// --- feed_reshare metadata ---
						if (e2eType === 'feed_reshare') {
							fullMessage.feedReshare = true
						}
						// --- view_once type from enc attributes ---
						if (attrs.view_once === 'read' || attrs.view_once === 'write') {
							fullMessage.viewOnceType = attrs.view_once
						}
						// --- XMA message ---
						if (msg.xmaMessage) {
							fullMessage.xma = msg.xmaMessage
							fullMessage.messageType = 'xma'
						}
						// --- native_flow_response ---
						if (e2eType === 'native_flow_response' || msg.nativeFlowResponseMessage) {
							fullMessage.messageType = 'native_flow_response'
							if (msg.nativeFlowResponseMessage) {
								fullMessage.nativeFlowResponse = msg.nativeFlowResponseMessage
								// SMB quick reply is a business-specific native flow variant
								if (msg.nativeFlowResponseMessage.name === 'md_smb_quick_reply') {
									fullMessage.smbQuickReply = true
								}
							}
						}
						// --- call_permission_request ---
						if (msg.callPermissionRequestMessage) {
							fullMessage.messageType = 'call_permission_request'
							fullMessage.callPermissionRequest = msg.callPermissionRequestMessage
						}
						// --- Product / Order / Catalog types ---
						if (msg.productMessage) {
							fullMessage.messageType = 'product'
						} else if (msg.orderMessage) {
							fullMessage.messageType = 'order'
						} else if (msg.catalogMessage || msg.listMessage?.catalogType) {
							fullMessage.messageType = 'catalog'
						}
						// --- Payment types ---
						if (msg.paymentMessage) {
							fullMessage.messageType = 'payment'
							const pm = msg.paymentMessage
							fullMessage.paymentInfo = {
								amount: pm.amount1000 ? pm.amount1000 / 1000 : null,
								currency: pm.currencyCodeIso4217 || null,
								status: pm.status || null,
								transactionTimestamp: pm.transactionTimestamp
									? pm.transactionTimestamp.toNumber?.() || pm.transactionTimestamp
									: null,
								type: pm.type || null,
								method: pm.paymentMethod || null,
								futureProofed: pm.futureProofed || false
							}
						}
						if (msg.requestPaymentMessage) {
							fullMessage.messageType = 'request_payment'
							fullMessage.paymentRequest = {
								amount: msg.requestPaymentMessage.amount || null,
								currency: msg.requestPaymentMessage.currencyCodeIso4217 || null,
								expiry: msg.requestPaymentMessage.expiryTimestamp || null
							}
						}
						if (msg.sendPaymentMessage) {
							fullMessage.messageType = 'send_payment'
						}
						if (msg.cancelPaymentRequestMessage) {
							fullMessage.messageType = 'cancel_payment'
						}
						// --- Sticker flags ---
						if (msg.stickerMessage) {
							if (msg.stickerMessage.isAvatar) {
								fullMessage.isAvatarSticker = true
							}
							if (msg.stickerMessage.isAiSticker || msg.stickerMessage.isGenAI) {
								fullMessage.isAiSticker = true
							}
						}
						// --- StickerPackMessage ---
						if (msg.stickerPackMessage) {
							fullMessage.messageType = 'sticker_pack'
							const sp = msg.stickerPackMessage
							fullMessage.stickerPack = {
								id: sp.stickerPackId,
								name: sp.name,
								// 0 = FIRST_PARTY, 1 = THIRD_PARTY
								origin: sp.stickerPackOrigin,
								size: sp.stickerPackSize,
								stickers: sp.stickers || []
							}
						}
						// --- AI media collection metadata from bot context ---
						if (msg.messageContextInfo?.botMetadata?.aiMediaCollectionMetadata) {
							fullMessage.aiMediaCollectionMetadata = {
								collectionId: msg.messageContextInfo.botMetadata.aiMediaCollectionMetadata.collectionId,
								uploadOrderIndex: msg.messageContextInfo.botMetadata.aiMediaCollectionMetadata.uploadOrderIndex
							}
						}
						// --- ProtocolMessage: AI media collection coordination ---
						if (msg.protocolMessage?.aiMediaCollectionMessage) {
							fullMessage.messageType = 'ai_media_collection'
							const amc = msg.protocolMessage.aiMediaCollectionMessage
							fullMessage.aiMediaCollection = {
								collectionId: amc.collectionId,
								expectedMediaCount: amc.expectedMediaCount
							}
						}
						// --- SplitPaymentMessage ---
						if (msg.splitPaymentMessage) {
							fullMessage.messageType = 'split_payment'
							const sp = msg.splitPaymentMessage
							fullMessage.splitPayment = {
								splitId: sp.splitId,
								totalAmount: sp.totalAmount,
								description: sp.description,
								requesterJid: sp.requesterJid,
								participants: (sp.participants || []).map(p => ({
									jid: p.jid,
									amount: p.amount,
									// 0 = PENDING, 1 = PAID
									status: p.status
								})),
								createdAtMs: sp.createdAtMs ? sp.createdAtMs.toNumber?.() || sp.createdAtMs : null
							}
						}
						// --- PaymentInviteMessage (FBPAY / UPI / NOVI) ---
						if (msg.paymentInviteMessage) {
							fullMessage.messageType = 'payment_invite'
							const SERVICE_TYPE = { 0: 'UNKNOWN', 1: 'FBPAY', 2: 'NOVI', 3: 'UPI' }
							fullMessage.paymentInvite = {
								serviceType: SERVICE_TYPE[msg.paymentInviteMessage.serviceType] || 'UNKNOWN',
								expiry: msg.paymentInviteMessage.expiryTimestamp
									? msg.paymentInviteMessage.expiryTimestamp.toNumber?.() || msg.paymentInviteMessage.expiryTimestamp
									: null,
								incentiveEligible: msg.paymentInviteMessage.incentiveEligible || false
							}
						}
						// --- PaymentReminderMessage ---
						if (msg.paymentReminderMessage) {
							fullMessage.messageType = 'payment_reminder'
						}
						// --- companion_enc_static ---
						if (e2eType === 'companion_enc_static') {
							fullMessage.companionEncStatic = true
						}
						// --- avatar_sticker / genai_sticker enc type ---
						if (e2eType === 'avatar_sticker' || e2eType === 'genai_sticker') {
							fullMessage.stickerType = e2eType
						}
						// --- account_authentication_request ---
						if (e2eType === 'account_authentication_request' || msg.accountAuthRequestMessage) {
							fullMessage.messageType = 'account_auth_request'
						}
						// --- motion_video ---
						if (e2eType === 'motion_video' || (msg.videoMessage && msg.videoMessage.motionVideo)) {
							fullMessage.messageType = 'motion_video'
							fullMessage.motionVideo = true
						}
						// --- motion_photo ---
						if (e2eType === 'motion_photo' || (msg.imageMessage && msg.imageMessage.motionPhoto)) {
							fullMessage.messageType = 'motion_photo'
							fullMessage.motionPhoto = true
						}
						// --- non-E2EE plaintext (newsletter / system channel messages) ---
						if (e2eType === 'plaintext') {
							fullMessage.isNonE2EE = true
						}
						// Auto-decode richResponseMessage text so m.msg.text is populated
						{
							const rich = fullMessage.message?.richResponseMessage
							if (rich && !rich.text) {
								const decoded = decodeRichResponseMessage(rich)
								if (decoded) rich.text = decoded
							}
							const editedRich = fullMessage.message?.protocolMessage?.editedMessage?.richResponseMessage
							if (editedRich && !editedRich.text) {
								const decoded = decodeRichResponseMessage(editedRich)
								if (decoded) editedRich.text = decoded
							}
						}
						// Save messageSecret for any message (AI group server may set it on any message)
						{
							const secret = msg.messageContextInfo?.messageSecret
							if (secret) {
								const secretBuf = Buffer.isBuffer(secret)
									? secret
									: Buffer.from(secret.buffer, secret.byteOffset, secret.byteLength)
								setBotMessageSecret(fullMessage.key.id, secretBuf, fullMessage.key.remoteJid)
							}
						}
					} catch (err) {
						const errorContext = {
							key: fullMessage.key,
							err,
							messageType: tag === 'plaintext' ? 'plaintext' : attrs.type,
							sender,
							author,
							isSessionRecordError: isSessionRecordError(err)
						}
						logger.error(errorContext, 'failed to decrypt message')
						fullMessage.messageStubType = WAProto_1.proto.WebMessageInfo.StubType.CIPHERTEXT
						fullMessage.messageStubParameters = [err.message.toString()]
					}
				}
			}
			// if nothing was found to decrypt
			if (!decryptables && !fullMessage.key?.isViewOnce) {
				fullMessage.messageStubType = WAProto_1.proto.WebMessageInfo.StubType.CIPHERTEXT
				fullMessage.messageStubParameters = [exports.NO_MESSAGE_FOUND_ERROR_TEXT]
			}
		}
	}
}
exports.decryptMessageNode = decryptMessageNode
/**
 * Decode text content from a richResponseMessage (Meta AI).
 * Tries submessages first, then parses base64 JSON from unifiedResponse.data.
 * Returns the extracted text string or '' on failure.
 */
function decodeRichResponseMessage(richMsg) {
	try {
		if (!richMsg) return ''
		if (Array.isArray(richMsg.submessages) && richMsg.submessages.length > 0) {
			const sub = richMsg.submessages
				.map(s => s.messageText)
				.filter(Boolean)
				.join('\n')
			if (sub) return sub
		}
		const data = richMsg.unifiedResponse?.data
		if (!data) return ''
		const json = JSON.parse(Buffer.from(data, 'base64').toString('utf8'))
		const texts = []
		for (const section of json.sections || []) {
			const prim = section?.view_model?.primitive
			if (prim?.text) texts.push(prim.text)
			if (prim?.header) texts.push(prim.header)
			for (const sub of section?.view_model?.items || []) {
				if (sub?.primitive?.text) texts.push(sub.primitive.text)
			}
		}
		return texts.join('\n')
	} catch {
		return ''
	}
}
/**
 * Utility function to check if an error is related to missing session record
 */
function isSessionRecordError(error) {
	const errorMessage = error?.message || error?.toString() || ''
	return exports.DECRYPTION_RETRY_CONFIG.sessionRecordErrors.some(errorPattern => errorMessage.includes(errorPattern))
}
