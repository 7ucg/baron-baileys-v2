'use strict'
Object.defineProperty(exports, '__esModule', { value: true })
exports.getChatId = exports.shouldIncrementChatUnread = exports.isRealMessage = exports.cleanMessage = void 0
exports.decryptPollVote = decryptPollVote
exports.decryptEventResponse = decryptEventResponse
const index_js_1 = require('../../WAProto/index.js')
const Types_1 = require('../Types')
const messages_1 = require('../Utils/messages')
const WABinary_1 = require('../WABinary')
const crypto_1 = require('./crypto')
const generics_1 = require('./generics')
const history_1 = require('./history')
const tc_token_utils_1 = require('./tc-token-utils')
async function storeTcTokensFromHistorySync(chats, signalRepository, keyStore, logger) {
	const getLIDForPN = signalRepository.lidMapping.getLIDForPN.bind(signalRepository.lidMapping)
	const candidates = []
	for (const chat of chats) {
		const ts = chat.tcTokenTimestamp ? (0, generics_1.toNumber)(chat.tcTokenTimestamp) : 0
		if (chat.tcToken?.length && ts > 0) {
			const jid = (0, WABinary_1.jidNormalizedUser)(chat.id)
			const storageJid = await (0, tc_token_utils_1.resolveTcTokenJid)(jid, getLIDForPN)
			candidates.push({
				storageJid,
				token: Buffer.from(chat.tcToken),
				ts,
				senderTs: chat.tcTokenSenderTimestamp ? (0, generics_1.toNumber)(chat.tcTokenSenderTimestamp) : undefined
			})
		}
	}
	if (!candidates.length) return
	const jids = candidates.map(c => c.storageJid)
	const existing = await keyStore.get('tctoken', jids)
	const entries = {}
	for (const c of candidates) {
		const existingEntry = existing[c.storageJid]
		const existingTs = existingEntry?.timestamp ? Number(existingEntry.timestamp) : 0
		if (existingTs > 0 && existingTs >= c.ts) continue
		entries[c.storageJid] = {
			...existingEntry,
			token: c.token,
			timestamp: String(c.ts),
			...(c.senderTs !== undefined ? { senderTimestamp: c.senderTs } : {})
		}
	}
	if (Object.keys(entries).length) {
		logger?.debug({ count: Object.keys(entries).length }, 'storing tctokens from history sync')
		try {
			const indexWrite = await (0, tc_token_utils_1.buildMergedTcTokenIndexWrite)(keyStore, Object.keys(entries))
			await keyStore.set({ tctoken: { ...entries, ...indexWrite } })
		} catch (err) {
			logger?.warn({ err }, 'failed to store tctokens from history sync')
		}
	}
}
const REAL_MSG_STUB_TYPES = new Set([
	Types_1.WAMessageStubType.CALL_MISSED_GROUP_VIDEO,
	Types_1.WAMessageStubType.CALL_MISSED_GROUP_VOICE,
	Types_1.WAMessageStubType.CALL_MISSED_VIDEO,
	Types_1.WAMessageStubType.CALL_MISSED_VOICE
])
const REAL_MSG_REQ_ME_STUB_TYPES = new Set([Types_1.WAMessageStubType.GROUP_PARTICIPANT_ADD])
/** Cleans a received message to further processing */
const cleanMessage = (message, meId, meLid) => {
	// ensure remoteJid and participant doesn't have device or agent in it
	if ((0, WABinary_1.isHostedPnUser)(message.key.remoteJid) || (0, WABinary_1.isHostedLidUser)(message.key.remoteJid)) {
		message.key.remoteJid = (0, WABinary_1.jidEncode)(
			(0, WABinary_1.jidDecode)(message.key?.remoteJid)?.user,
			(0, WABinary_1.isHostedPnUser)(message.key.remoteJid) ? 's.whatsapp.net' : 'lid'
		)
	} else {
		message.key.remoteJid = (0, WABinary_1.jidNormalizedUser)(message.key.remoteJid)
	}
	if (
		(0, WABinary_1.isHostedPnUser)(message.key.participant) ||
		(0, WABinary_1.isHostedLidUser)(message.key.participant)
	) {
		message.key.participant = (0, WABinary_1.jidEncode)(
			(0, WABinary_1.jidDecode)(message.key.participant)?.user,
			(0, WABinary_1.isHostedPnUser)(message.key.participant) ? 's.whatsapp.net' : 'lid'
		)
	} else {
		message.key.participant = (0, WABinary_1.jidNormalizedUser)(message.key.participant)
	}
	const content = (0, messages_1.normalizeMessageContent)(message.message)
	// if the message has a reaction, ensure fromMe & remoteJid are from our perspective
	if (content?.reactionMessage) {
		normaliseKey(content.reactionMessage.key)
	}
	if (content?.pollUpdateMessage) {
		normaliseKey(content.pollUpdateMessage.pollCreationMessageKey)
	}
	function normaliseKey(msgKey) {
		// if the reaction is from another user
		// we've to correctly map the key to this user's perspective
		if (!message.key.fromMe) {
			// if the sender believed the message being reacted to is not from them
			// we've to correct the key to be from them, or some other participant
			msgKey.fromMe = !msgKey.fromMe
				? (0, WABinary_1.areJidsSameUser)(msgKey.participant || msgKey.remoteJid, meId) ||
					(0, WABinary_1.areJidsSameUser)(msgKey.participant || msgKey.remoteJid, meLid)
				: // if the message being reacted to, was from them
					// fromMe automatically becomes false
					false
			// set the remoteJid to being the same as the chat the message came from
			// TODO: investigate inconsistencies
			msgKey.remoteJid = message.key.remoteJid
			// set participant of the message
			msgKey.participant = msgKey.participant || message.key.participant
		}
	}
}
exports.cleanMessage = cleanMessage
const isRealMessage = message => {
	// Stub-type system events (missed calls, participant-add) never carry message.message,
	// so they must short-circuit here — gating them behind hasSomeContent below made this
	// branch permanently dead (audited 2026-07-19).
	if (REAL_MSG_STUB_TYPES.has(message.messageStubType) || REAL_MSG_REQ_ME_STUB_TYPES.has(message.messageStubType)) {
		return true
	}
	const normalizedContent = (0, messages_1.normalizeMessageContent)(message.message)
	const hasSomeContent = !!(0, messages_1.getContentType)(normalizedContent)
	return (
		!!normalizedContent &&
		hasSomeContent &&
		!normalizedContent?.protocolMessage &&
		!normalizedContent?.reactionMessage &&
		!normalizedContent?.pollUpdateMessage
	)
}
exports.isRealMessage = isRealMessage
const shouldIncrementChatUnread = message => !message.key.fromMe && !message.messageStubType
exports.shouldIncrementChatUnread = shouldIncrementChatUnread
/**
 * Get the ID of the chat from the given key.
 * Typically -- that'll be the remoteJid, but for broadcasts, it'll be the participant
 */
const getChatId = ({ remoteJid, participant, fromMe }) => {
	if ((0, WABinary_1.isJidBroadcast)(remoteJid) && !(0, WABinary_1.isJidStatusBroadcast)(remoteJid) && !fromMe) {
		return participant
	}
	return remoteJid
}
exports.getChatId = getChatId
/**
 * Decrypt a poll vote
 * @param vote encrypted vote
 * @param ctx additional info about the poll required for decryption
 * @returns list of SHA256 options
 */
function decryptPollVote({ encPayload, encIv }, { pollCreatorJid, pollMsgId, pollEncKey, voterJid }) {
	const sign = Buffer.concat([
		toBinary(pollMsgId),
		toBinary(pollCreatorJid),
		toBinary(voterJid),
		toBinary('Poll Vote'),
		new Uint8Array([1])
	])
	const key0 = (0, crypto_1.hmacSign)(pollEncKey, new Uint8Array(32), 'sha256')
	const decKey = (0, crypto_1.hmacSign)(sign, key0, 'sha256')
	const aad = toBinary(`${pollMsgId}\u0000${voterJid}`)
	const decrypted = (0, crypto_1.aesDecryptGCM)(encPayload, decKey, encIv, aad)
	return index_js_1.proto.Message.PollVoteMessage.decode(decrypted)
	function toBinary(txt) {
		return Buffer.from(txt)
	}
}
/**
 * Decrypt an event response
 * @param response encrypted event response
 * @param ctx additional info about the event required for decryption
 * @returns event response message
 */
function decryptEventResponse({ encPayload, encIv }, { eventCreatorJid, eventMsgId, eventEncKey, responderJid }) {
	const sign = Buffer.concat([
		toBinary(eventMsgId),
		toBinary(eventCreatorJid),
		toBinary(responderJid),
		toBinary('Event Response'),
		new Uint8Array([1])
	])
	const key0 = (0, crypto_1.hmacSign)(eventEncKey, new Uint8Array(32), 'sha256')
	const decKey = (0, crypto_1.hmacSign)(sign, key0, 'sha256')
	const aad = toBinary(`${eventMsgId}\u0000${responderJid}`)
	const decrypted = (0, crypto_1.aesDecryptGCM)(encPayload, decKey, encIv, aad)
	return index_js_1.proto.Message.EventResponseMessage.decode(decrypted)
	function toBinary(txt) {
		return Buffer.from(txt)
	}
}
const processMessage = async (
	message,
	{
		shouldProcessHistoryMsg,
		placeholderResendCache,
		ev,
		creds,
		signalRepository,
		keyStore,
		logger,
		options,
		getMessage
	}
) => {
	const meId = creds.me.id
	const { accountSettings } = creds
	const chat = { id: (0, WABinary_1.jidNormalizedUser)((0, exports.getChatId)(message.key)) }
	const isRealMsg = (0, exports.isRealMessage)(message)
	if (isRealMsg) {
		chat.messages = [{ message }]
		chat.conversationTimestamp = (0, generics_1.toNumber)(message.messageTimestamp)
		// only increment unread count if not CIPHERTEXT and from another person
		if ((0, exports.shouldIncrementChatUnread)(message)) {
			chat.unreadCount = (chat.unreadCount || 0) + 1
		}
	}
	if (message.statusPsa) {
		ev.emit('status.psa', {
			key: message.key,
			psa: message.statusPsa,
			chatId: chat.id
		})
	}
	if (message.quarantinedMessage) {
		ev.emit('message.quarantined', {
			key: message.key,
			quarantineInfo: message.quarantinedMessage,
			chatId: chat.id
		})
	}
	if (message.interactiveMessageAdditionalMetadata?.isGalaxyFlowCompleted) {
		ev.emit('galaxy.flow.completed', {
			key: message.key,
			chatId: chat.id
		})
	}
	if (message.ephemeralExpirationTimestamp) {
		Object.assign(chat, {
			ephemeralExpirationTimestamp: (0, generics_1.toNumber)(message.ephemeralExpirationTimestamp)
		})
	}
	const content = (0, messages_1.normalizeMessageContent)(message.message)
	// unarchive chat if it's a real message, or someone reacted to our message
	// and we've the unarchive chats setting on
	if ((isRealMsg || content?.reactionMessage?.key?.fromMe) && accountSettings?.unarchiveChats) {
		chat.archived = false
		chat.readOnly = false
	}
	const protocolMsg = content?.protocolMessage
	if (protocolMsg) {
		switch (protocolMsg.type) {
			case index_js_1.proto.Message.ProtocolMessage.Type.HISTORY_SYNC_NOTIFICATION:
				const histNotification = protocolMsg.historySyncNotification
				const process = shouldProcessHistoryMsg
				const isLatest = !creds.processedHistoryMessages?.length
				logger?.info(
					{
						histNotification,
						process,
						id: message.key.id,
						isLatest
					},
					'got history notification'
				)
				if (process) {
					// TODO: investigate
					if (histNotification.syncType !== index_js_1.proto.HistorySync.HistorySyncType.ON_DEMAND) {
						ev.emit('creds.update', {
							processedHistoryMessages: [
								...(creds.processedHistoryMessages || []),
								{ key: message.key, messageTimestamp: message.messageTimestamp }
							]
						})
					}
					const data = await (0, history_1.downloadAndProcessHistorySyncNotification)(histNotification, options, logger)
					if (data.lidPnMappings?.length) {
						logger?.debug({ count: data.lidPnMappings.length }, 'processing LID-PN mappings from history sync')
						await signalRepository.lidMapping
							.storeLIDPNMappings(data.lidPnMappings)
							.catch(err => logger?.warn({ err }, 'failed to store LID-PN mappings from history sync'))
					}
					await storeTcTokensFromHistorySync(data.chats, signalRepository, keyStore, logger)
					ev.emit('messaging-history.set', {
						...data,
						isLatest:
							histNotification.syncType !== index_js_1.proto.HistorySync.HistorySyncType.ON_DEMAND
								? isLatest
								: undefined,
						peerDataRequestSessionId: histNotification.peerDataRequestSessionId
					})
				}
				break
			case index_js_1.proto.Message.ProtocolMessage.Type.APP_STATE_SYNC_KEY_SHARE:
				const keys = protocolMsg.appStateSyncKeyShare.keys
				if (keys?.length) {
					let newAppStateSyncKeyId = ''
					await keyStore.transaction(async () => {
						const newKeys = []
						for (const { keyData, keyId } of keys) {
							const strKeyId = Buffer.from(keyId.keyId).toString('base64')
							newKeys.push(strKeyId)
							await keyStore.set({ 'app-state-sync-key': { [strKeyId]: keyData } })
							newAppStateSyncKeyId = strKeyId
						}
						logger?.info({ newAppStateSyncKeyId, newKeys }, 'injecting new app state sync keys')
					}, meId)
					ev.emit('creds.update', { myAppStateKeyId: newAppStateSyncKeyId })
				} else {
					logger?.info({ protocolMsg }, 'recv app state sync with 0 keys')
				}
				break
			case index_js_1.proto.Message.ProtocolMessage.Type.REVOKE:
				ev.emit('messages.update', [
					{
						key: {
							...message.key,
							id: protocolMsg.key.id
						},
						update: { message: null, messageStubType: Types_1.WAMessageStubType.REVOKE, key: message.key }
					}
				])
				break
			case index_js_1.proto.Message.ProtocolMessage.Type.EPHEMERAL_SETTING:
				Object.assign(chat, {
					ephemeralSettingTimestamp: (0, generics_1.toNumber)(message.messageTimestamp),
					ephemeralExpiration: protocolMsg.ephemeralExpiration || null
				})
				break
			case index_js_1.proto.Message.ProtocolMessage.Type.PEER_DATA_OPERATION_REQUEST_RESPONSE_MESSAGE:
				const response = protocolMsg.peerDataOperationRequestResponseMessage
				if (response) {
					// TODO: IMPLEMENT HISTORY SYNC ETC (sticker uploads etc.).
					const peerDataOperationResult = response.peerDataOperationResult || []
					for (const result of peerDataOperationResult) {
						const retryResponse = result?.placeholderMessageResendResponse
						//eslint-disable-next-line max-depth
						if (!retryResponse?.webMessageInfoBytes) {
							continue
						}
						//eslint-disable-next-line max-depth
						try {
							const webMessageInfo = index_js_1.proto.WebMessageInfo.decode(retryResponse.webMessageInfoBytes)
							const msgId = webMessageInfo.key?.id
							// Retrieve cached original message data (preserves LID details,
							// timestamps, etc. that the phone may omit in its PDO response)
							const cachedData = msgId ? await placeholderResendCache?.get(msgId) : undefined
							//eslint-disable-next-line max-depth
							if (msgId) {
								await placeholderResendCache?.del(msgId)
							}
							let finalMsg
							//eslint-disable-next-line max-depth
							if (cachedData && typeof cachedData === 'object') {
								// Apply decoded message content onto cached metadata (preserves LID etc.)
								cachedData.message = webMessageInfo.message
								//eslint-disable-next-line max-depth
								if (webMessageInfo.messageTimestamp) {
									cachedData.messageTimestamp = webMessageInfo.messageTimestamp
								}
								finalMsg = cachedData
							} else {
								finalMsg = webMessageInfo
							}
							logger?.debug({ msgId, requestId: response.stanzaId }, 'received placeholder resend')
							ev.emit('messages.upsert', {
								messages: [finalMsg],
								type: 'notify',
								requestId: response.stanzaId
							})
						} catch (err) {
							logger?.warn({ err, stanzaId: response.stanzaId }, 'failed to decode placeholder resend response')
						}
					}
				}
				break
			case index_js_1.proto.Message.ProtocolMessage.Type.MESSAGE_EDIT:
				ev.emit('messages.update', [
					{
						// flip the sender / fromMe properties because they're in the perspective of the sender
						key: { ...message.key, id: protocolMsg.key?.id },
						update: {
							message: {
								editedMessage: {
									message: protocolMsg.editedMessage
								}
							},
							messageTimestamp: protocolMsg.timestampMs
								? Math.floor((0, generics_1.toNumber)(protocolMsg.timestampMs) / 1000)
								: message.messageTimestamp
						}
					}
				])
				break
			case index_js_1.proto.Message.ProtocolMessage.Type.GROUP_MEMBER_LABEL_CHANGE:
				const labelAssociationMsg = protocolMsg.memberLabel
				if (labelAssociationMsg?.label) {
					ev.emit('group.member-tag.update', {
						groupId: chat.id,
						label: labelAssociationMsg.label,
						participant: message.key.participant,
						participantAlt: message.key.participantAlt,
						messageTimestamp: Number(message.messageTimestamp)
					})
				}
				break
			case index_js_1.proto.Message.ProtocolMessage.Type.BOT_FEEDBACK_MESSAGE:
				if (protocolMsg.botFeedbackMessage) {
					ev.emit('bot.feedback', {
						key: message.key,
						botFeedback: protocolMsg.botFeedbackMessage,
						targetKey: protocolMsg.key
					})
				}
				break
			case index_js_1.proto.Message.ProtocolMessage.Type.CLOUD_API_THREAD_CONTROL_NOTIFICATION:
				if (protocolMsg.cloudAPIThreadControlNotification) {
					ev.emit('cloud.thread.control', {
						key: message.key,
						notification: protocolMsg.cloudAPIThreadControlNotification,
						chatId: chat.id
					})
				}
				break
			case index_js_1.proto.Message.ProtocolMessage.Type.CHAT_THEME_SETTING:
				if (protocolMsg.chatThemeSetting) {
					ev.emit('chats.update', [
						{
							id: chat.id,
							chatThemeSetting: protocolMsg.chatThemeSetting
						}
					])
				}
				break
			case index_js_1.proto.Message.ProtocolMessage.Type.STOP_GENERATION_MESSAGE:
				ev.emit('bot.stop-generation', {
					key: message.key,
					targetKey: protocolMsg.key,
					chatId: chat.id
				})
				break
			case index_js_1.proto.Message.ProtocolMessage.Type.MEDIA_NOTIFY_MESSAGE:
				if (protocolMsg.mediaNotifyMessage) {
					ev.emit('media.notify', {
						key: message.key,
						mediaNotify: protocolMsg.mediaNotifyMessage
					})
				}
				break
			case index_js_1.proto.Message.ProtocolMessage.Type.REQUEST_WELCOME_MESSAGE:
				ev.emit('bot.welcome-request', {
					key: message.key,
					chatId: chat.id,
					timestamp: message.messageTimestamp
				})
				break
			case index_js_1.proto.Message.ProtocolMessage.Type.BOT_MEMU_ONBOARDING_MESSAGE:
				ev.emit('bot.memu-onboarding', {
					key: message.key,
					chatId: chat.id
				})
				break
			case index_js_1.proto.Message.ProtocolMessage.Type.STATUS_MENTION_MESSAGE:
				if (protocolMsg.statusMentionMessage) {
					ev.emit('status.mention', {
						key: message.key,
						statusMention: protocolMsg.statusMentionMessage,
						chatId: chat.id
					})
				}
				break
			case index_js_1.proto.Message.ProtocolMessage.Type.AI_PSI_METADATA:
				if (protocolMsg.aiPsiMetadata) {
					ev.emit('bot.psi-metadata', {
						key: message.key,
						psiMetadata: protocolMsg.aiPsiMetadata,
						chatId: chat.id
					})
				}
				break
			case index_js_1.proto.Message.ProtocolMessage.Type.AI_QUERY_FANOUT:
				if (protocolMsg.aiQueryFanout) {
					ev.emit('bot.query-fanout', {
						key: message.key,
						queryFanout: protocolMsg.aiQueryFanout,
						chatId: chat.id
					})
				}
				break
			case index_js_1.proto.Message.ProtocolMessage.Type.AI_MEDIA_COLLECTION_MESSAGE:
				if (protocolMsg.aiMediaCollectionMessage) {
					ev.emit('bot.media-collection', {
						key: message.key,
						collection: protocolMsg.aiMediaCollectionMessage,
						chatId: chat.id
					})
				}
				break
			case index_js_1.proto.Message.ProtocolMessage.Type.REMINDER_MESSAGE:
				ev.emit('reminder.update', {
					key: message.key,
					chatId: chat.id,
					timestamp: message.messageTimestamp
				})
				break
			case index_js_1.proto.Message.ProtocolMessage.Type.MESSAGE_UNSCHEDULE:
				if (protocolMsg.key) {
					ev.emit('messages.update', [
						{
							key: { ...message.key, id: protocolMsg.key.id },
							update: { scheduledMessageMetadata: null }
						}
					])
				}
				break
			case index_js_1.proto.Message.ProtocolMessage.Type.LID_MIGRATION_MAPPING_SYNC:
				const encodedPayload = protocolMsg.lidMigrationMappingSyncMessage?.encodedMappingPayload
				const { pnToLidMappings, chatDbMigrationTimestamp } =
					index_js_1.proto.LIDMigrationMappingSyncPayload.decode(encodedPayload)
				logger?.debug({ pnToLidMappings, chatDbMigrationTimestamp }, 'got lid mappings and chat db migration timestamp')
				const pairs = []
				for (const { pn, latestLid, assignedLid } of pnToLidMappings) {
					const lid = latestLid || assignedLid
					pairs.push({ lid: `${lid}@lid`, pn: `${pn}@s.whatsapp.net` })
				}
				await signalRepository.lidMapping.storeLIDPNMappings(pairs)
				if (pairs.length) {
					for (const { pn, lid } of pairs) {
						await signalRepository.migrateSession(pn, lid)
					}
				}
		}
	} else if (content?.reactionMessage) {
		const reaction = {
			...content.reactionMessage,
			key: message.key
		}
		ev.emit('messages.reaction', [
			{
				reaction,
				key: content.reactionMessage?.key
			}
		])
	} else if (content?.keepInChatMessage) {
		const kic = content.keepInChatMessage
		if (kic.key) {
			ev.emit('messages.update', [
				{
					key: kic.key,
					update: { keepInChat: { keepType: kic.keepType, serverTimestamp: message.messageTimestamp, key: kic.key } }
				}
			])
		}
	} else if (content?.encReactionMessage) {
		ev.emit('messages.update', [
			{
				key: content.encReactionMessage.targetMessageKey,
				update: { encReactionMessage: content.encReactionMessage }
			}
		])
	} else if (content?.commentMessage) {
		if (content.commentMessage.targetMessageKey) {
			ev.emit('message.comment', {
				comment: content.commentMessage,
				commentKey: message.key,
				targetKey: content.commentMessage.targetMessageKey
			})
		}
	} else if (content?.encCommentMessage) {
		ev.emit('message.comment', {
			comment: content.encCommentMessage,
			commentKey: message.key,
			targetKey: content.encCommentMessage.targetMessageKey,
			encrypted: true
		})
	} else if (content?.bcallMessage) {
		ev.emit('call', [
			{
				id: content.bcallMessage.sessionId || message.key.id,
				from: message.key.participant || message.key.remoteJid,
				chatId: chat.id,
				isVideo: content.bcallMessage.mediaType === index_js_1.proto.Message.BCallMessage.MediaType.VIDEO,
				isBroadcast: true,
				caption: content.bcallMessage.caption
			}
		])
	} else if (content?.pollAddOptionMessage) {
		const pao = content.pollAddOptionMessage
		if (pao.pollCreationMessageKey) {
			ev.emit('poll.add-option', {
				pollKey: pao.pollCreationMessageKey,
				addedOption: pao.addOption,
				addedBy: message.key.participant || message.key.remoteJid,
				messageKey: message.key
			})
		}
	} else if (content?.scheduledCallCreationMessage) {
		ev.emit('call.scheduled', {
			messageKey: message.key,
			scheduledCall: content.scheduledCallCreationMessage,
			chatId: chat.id
		})
	} else if (content?.scheduledCallEditMessage) {
		ev.emit('call.schedule-cancelled', {
			messageKey: message.key,
			editedCallKey: content.scheduledCallEditMessage.key,
			chatId: chat.id
		})
	} else if (content?.splitPaymentMessage) {
		ev.emit('payment.split', {
			messageKey: message.key,
			splitPayment: content.splitPaymentMessage,
			chatId: chat.id
		})
	} else if (content?.p2PPaymentReminderNotification) {
		ev.emit('payment.reminder', {
			messageKey: message.key,
			reminder: content.p2PPaymentReminderNotification,
			chatId: chat.id
		})
	} else if (content?.encEventResponseMessage) {
		const encEventResponse = content.encEventResponseMessage
		const creationMsgKey = encEventResponse.eventCreationMessageKey
		// we need to fetch the event creation message to get the event enc key
		const eventMsg = await getMessage(creationMsgKey)
		if (eventMsg) {
			try {
				const meIdNormalised = (0, WABinary_1.jidNormalizedUser)(meId)
				// all jids need to be PN
				const eventCreatorKey = creationMsgKey.participant || creationMsgKey.remoteJid
				const eventCreatorPn = (0, WABinary_1.isLidUser)(eventCreatorKey)
					? await signalRepository.lidMapping.getPNForLID(eventCreatorKey)
					: eventCreatorKey
				const eventCreatorJid = (0, generics_1.getKeyAuthor)(
					{ remoteJid: (0, WABinary_1.jidNormalizedUser)(eventCreatorPn), fromMe: meIdNormalised === eventCreatorPn },
					meIdNormalised
				)
				const responderJid = (0, generics_1.getKeyAuthor)(message.key, meIdNormalised)
				const eventEncKey = eventMsg?.messageContextInfo?.messageSecret
				if (!eventEncKey) {
					logger?.warn({ creationMsgKey }, 'event response: missing messageSecret for decryption')
				} else {
					const responseMsg = decryptEventResponse(encEventResponse, {
						eventEncKey,
						eventCreatorJid,
						eventMsgId: creationMsgKey.id,
						responderJid
					})
					const eventResponse = {
						eventResponseMessageKey: message.key,
						senderTimestampMs: responseMsg.timestampMs,
						response: responseMsg
					}
					ev.emit('messages.update', [
						{
							key: creationMsgKey,
							update: {
								eventResponses: [eventResponse]
							}
						}
					])
				}
			} catch (err) {
				logger?.warn({ err, creationMsgKey }, 'failed to decrypt event response')
			}
		} else {
			logger?.warn({ creationMsgKey }, 'event creation message not found, cannot decrypt response')
		}
	} else if (message.messageStubType) {
		const jid = message.key?.remoteJid
		//let actor = whatsappID (message.participant)
		let participants
		const emitParticipantsUpdate = action =>
			ev.emit('group-participants.update', {
				id: jid,
				author: message.key.participant,
				authorPn: message.key.participantAlt,
				authorUsername: message.key.participantUsername,
				participants,
				action
			})
		const emitGroupUpdate = update => {
			ev.emit('groups.update', [
				{
					id: jid,
					...update,
					author: message.key.participant,
					authorPn: message.key.participantAlt,
					authorUsername: message.key.participantUsername
				}
			])
		}
		const emitGroupRequestJoin = (participant, action, method) => {
			ev.emit('group.join-request', {
				id: jid,
				author: message.key.participant,
				authorPn: message.key.participantAlt,
				authorUsername: message.key.participantUsername,
				participant: participant.lid,
				participantPn: participant.pn,
				action,
				method: method
			})
		}
		const participantsIncludesMe = () =>
			participants.find(jid => (0, WABinary_1.areJidsSameUser)(meId, jid.phoneNumber)) // ADD SUPPORT FOR LID
		switch (message.messageStubType) {
			case Types_1.WAMessageStubType.GROUP_PARTICIPANT_CHANGE_NUMBER:
				participants = message.messageStubParameters.map(a => JSON.parse(a)) || []
				emitParticipantsUpdate('modify')
				break
			case Types_1.WAMessageStubType.GROUP_PARTICIPANT_LEAVE:
			case Types_1.WAMessageStubType.GROUP_PARTICIPANT_REMOVE:
				participants = message.messageStubParameters.map(a => JSON.parse(a)) || []
				emitParticipantsUpdate('remove')
				// mark the chat read only if you left the group
				if (participantsIncludesMe()) {
					chat.readOnly = true
				}
				break
			case Types_1.WAMessageStubType.GROUP_PARTICIPANT_ADD:
			case Types_1.WAMessageStubType.GROUP_PARTICIPANT_INVITE:
			case Types_1.WAMessageStubType.GROUP_PARTICIPANT_ADD_REQUEST_JOIN:
				participants = message.messageStubParameters.map(a => JSON.parse(a)) || []
				if (participantsIncludesMe()) {
					chat.readOnly = false
				}
				emitParticipantsUpdate('add')
				break
			case Types_1.WAMessageStubType.GROUP_PARTICIPANT_DEMOTE:
				participants = message.messageStubParameters.map(a => JSON.parse(a)) || []
				emitParticipantsUpdate('demote')
				break
			case Types_1.WAMessageStubType.GROUP_PARTICIPANT_PROMOTE:
				participants = message.messageStubParameters.map(a => JSON.parse(a)) || []
				emitParticipantsUpdate('promote')
				break
			case Types_1.WAMessageStubType.GROUP_CHANGE_ANNOUNCE:
				const announceValue = message.messageStubParameters?.[0]
				emitGroupUpdate({ announce: announceValue === 'true' || announceValue === 'on' })
				break
			case Types_1.WAMessageStubType.GROUP_CHANGE_RESTRICT:
				const restrictValue = message.messageStubParameters?.[0]
				emitGroupUpdate({ restrict: restrictValue === 'true' || restrictValue === 'on' })
				break
			case Types_1.WAMessageStubType.GROUP_CHANGE_SUBJECT:
				const name = message.messageStubParameters?.[0]
				chat.name = name
				emitGroupUpdate({ subject: name })
				break
			case Types_1.WAMessageStubType.GROUP_CHANGE_DESCRIPTION:
				const description = message.messageStubParameters?.[0]
				chat.description = description
				emitGroupUpdate({ desc: description })
				break
			case Types_1.WAMessageStubType.GROUP_CHANGE_INVITE_LINK:
				const code = message.messageStubParameters?.[0]
				emitGroupUpdate({ inviteCode: code })
				break
			case Types_1.WAMessageStubType.GROUP_MEMBER_ADD_MODE:
				const memberAddValue = message.messageStubParameters?.[0]
				emitGroupUpdate({ memberAddMode: memberAddValue === 'all_member_add' })
				break
			case Types_1.WAMessageStubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_MODE:
				const approvalMode = message.messageStubParameters?.[0]
				emitGroupUpdate({ joinApprovalMode: approvalMode === 'on' })
				break
			case Types_1.WAMessageStubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_REQUEST_NON_ADMIN_ADD:
				const participant = JSON.parse(message.messageStubParameters?.[0])
				const action = message.messageStubParameters?.[1]
				const method = message.messageStubParameters?.[2]
				emitGroupRequestJoin(participant, action, method)
				break
			case Types_1.WAMessageStubType.GROUP_CREATE:
				emitGroupUpdate({ subject: message.messageStubParameters?.[0] })
				break
			case Types_1.WAMessageStubType.GROUP_CHANGE_ICON:
				emitGroupUpdate({ pictureId: message.messageStubParameters?.[0] })
				break
			case Types_1.WAMessageStubType.GROUP_DELETE:
				emitGroupUpdate({ readOnly: true, deleted: true })
				break
			case Types_1.WAMessageStubType.GROUP_CREATING:
				emitGroupUpdate({ subject: message.messageStubParameters?.[0], creating: true })
				break
			case Types_1.WAMessageStubType.GROUP_CREATE_FAILED:
				emitGroupUpdate({ createFailed: true })
				break
			case Types_1.WAMessageStubType.GROUP_BOUNCED:
				emitGroupUpdate({ bounced: true })
				break
			case Types_1.WAMessageStubType.CHANGE_EPHEMERAL_SETTING:
				const ephValue = message.messageStubParameters?.[0]
				emitGroupUpdate({ ephemeralDuration: ephValue ? +ephValue : 0 })
				break
			case Types_1.WAMessageStubType.DISAPPEARING_MODE:
				const disappearingValue = message.messageStubParameters?.[0]
				emitGroupUpdate({ ephemeralDuration: disappearingValue ? +disappearingValue : 0 })
				break
			case Types_1.WAMessageStubType.ADMIN_REVOKE:
				emitGroupUpdate({ adminRevoked: true, revokedBy: message.messageStubParameters?.[0] })
				break
			case Types_1.WAMessageStubType.BLOCK_CONTACT:
				ev.emit('contacts.update', [{ id: jid, isBlocked: true }])
				break
			case Types_1.WAMessageStubType.CHANGE_USERNAME:
				ev.emit('contacts.update', [
					{ id: message.key.participant || jid, username: message.messageStubParameters?.[0] }
				])
				break
			case Types_1.WAMessageStubType.GROUP_PARTICIPANT_ACCEPT:
				participants =
					message.messageStubParameters?.map(a => {
						try {
							return JSON.parse(a)
						} catch {
							return a
						}
					}) || []
				emitParticipantsUpdate('accept')
				break
			case Types_1.WAMessageStubType.GROUP_PARTICIPANT_LINKED_GROUP_JOIN:
				participants =
					message.messageStubParameters?.map(a => {
						try {
							return JSON.parse(a)
						} catch {
							return a
						}
					}) || []
				emitParticipantsUpdate('linked-group-join')
				break
			case Types_1.WAMessageStubType.EPHEMERAL_KEEP_IN_CHAT:
				ev.emit('messages.update', [{ key: message.key, update: { keepInChat: true } }])
				break
			case Types_1.WAMessageStubType.PINNED_MESSAGE_IN_CHAT:
				ev.emit('messages.update', [
					{
						key: message.key,
						update: {
							pinInChat: {
								pinned: true,
								pinnedMessageKey: message.messageStubParameters?.[0]
									? { id: message.messageStubParameters[0] }
									: undefined,
								senderTimestampMs: message.messageTimestamp
									? (0, generics_1.toNumber)(message.messageTimestamp) * 1000
									: undefined
							}
						}
					}
				])
				break
			case Types_1.WAMessageStubType.CHAT_PSA:
				ev.emit('chats.update', [{ id: jid, psa: { urlParams: message.messageStubParameters } }])
				break
			case Types_1.WAMessageStubType.CHAT_POLL_CREATION_MESSAGE:
				// poll was created, no special action needed beyond message processing
				break
			case Types_1.WAMessageStubType.BIZ_CHAT_ASSIGNMENT:
				ev.emit('chats.update', [
					{
						id: jid,
						bizAssignment: {
							assigned: true,
							assignee: message.messageStubParameters?.[0],
							agent: message.messageStubParameters?.[1]
						}
					}
				])
				break
			case Types_1.WAMessageStubType.BIZ_CHAT_ASSIGNMENT_UNASSIGN:
				ev.emit('chats.update', [{ id: jid, bizAssignment: { assigned: false } }])
				break
			case Types_1.WAMessageStubType.SILENCED_UNKNOWN_CALLER_AUDIO:
			case Types_1.WAMessageStubType.SILENCED_UNKNOWN_CALLER_VIDEO:
				ev.emit('call', [
					{
						id: message.messageStubParameters?.[0] || message.key.id,
						from: jid,
						isVideo: message.messageStubType === Types_1.WAMessageStubType.SILENCED_UNKNOWN_CALLER_VIDEO,
						status: 'silenced',
						isUnknown: true,
						timestamp: (0, generics_1.toNumber)(message.messageTimestamp)
					}
				])
				break
			case Types_1.WAMessageStubType.SCHEDULED_CALL_START_MESSAGE:
				ev.emit('call', [
					{
						id: message.messageStubParameters?.[0] || message.key.id,
						from: message.key.participant || jid,
						status: 'scheduled-start',
						timestamp: (0, generics_1.toNumber)(message.messageTimestamp)
					}
				])
				break
			case Types_1.WAMessageStubType.SCHEDULED_CALL_CANCEL:
				ev.emit('call', [
					{
						id: message.messageStubParameters?.[0] || message.key.id,
						from: message.key.participant || jid,
						status: 'schedule-cancelled',
						timestamp: (0, generics_1.toNumber)(message.messageTimestamp)
					}
				])
				break
			case Types_1.WAMessageStubType.COMMUNITY_CREATE:
				emitGroupUpdate({ isCommunity: true, subject: message.messageStubParameters?.[0] })
				break
			case Types_1.WAMessageStubType.COMMUNITY_LINK_PARENT_GROUP:
			case Types_1.WAMessageStubType.COMMUNITY_LINK_PARENT_GROUP_RICH:
				emitGroupUpdate({ linkedParent: message.messageStubParameters?.[0] })
				break
			case Types_1.WAMessageStubType.COMMUNITY_LINK_SUB_GROUP:
			case Types_1.WAMessageStubType.COMMUNITY_LINK_SIBLING_GROUP:
				emitGroupUpdate({ linkedSubGroup: message.messageStubParameters?.[0] })
				break
			case Types_1.WAMessageStubType.COMMUNITY_UNLINK_PARENT_GROUP:
				emitGroupUpdate({ linkedParent: undefined })
				break
			case Types_1.WAMessageStubType.COMMUNITY_UNLINK_SUB_GROUP:
			case Types_1.WAMessageStubType.COMMUNITY_UNLINK_SIBLING_GROUP:
				emitGroupUpdate({ unlinkedSubGroup: message.messageStubParameters?.[0] })
				break
			case Types_1.WAMessageStubType.COMMUNITY_PARTICIPANT_PROMOTE:
				participants =
					message.messageStubParameters?.map(a => {
						try {
							return JSON.parse(a)
						} catch {
							return a
						}
					}) || []
				emitParticipantsUpdate('promote')
				break
			case Types_1.WAMessageStubType.COMMUNITY_PARTICIPANT_DEMOTE:
				participants =
					message.messageStubParameters?.map(a => {
						try {
							return JSON.parse(a)
						} catch {
							return a
						}
					}) || []
				emitParticipantsUpdate('demote')
				break
			case Types_1.WAMessageStubType.COMMUNITY_PARENT_GROUP_DELETED:
				emitGroupUpdate({ parentDeleted: true, readOnly: true })
				break
			case Types_1.WAMessageStubType.COMMUNITY_PARENT_GROUP_SUBJECT_CHANGED:
				emitGroupUpdate({ parentSubject: message.messageStubParameters?.[0] })
				break
			case Types_1.WAMessageStubType.COMMUNITY_LINK_PARENT_GROUP_MEMBERSHIP_APPROVAL:
				emitGroupUpdate({ linkedParentMembershipApproval: message.messageStubParameters?.[0] === 'true' })
				break
			case Types_1.WAMessageStubType.COMMUNITY_INVITE_RICH:
			case Types_1.WAMessageStubType.COMMUNITY_INVITE_AUTO_ADD_RICH:
				participants =
					message.messageStubParameters?.map(a => {
						try {
							return JSON.parse(a)
						} catch {
							return a
						}
					}) || []
				emitParticipantsUpdate('add')
				break
			case Types_1.WAMessageStubType.COMMUNITY_PARTICIPANT_ADD_RICH:
				participants =
					message.messageStubParameters?.map(a => {
						try {
							return JSON.parse(a)
						} catch {
							return a
						}
					}) || []
				emitParticipantsUpdate('add')
				break
			case Types_1.WAMessageStubType.COMMUNITY_CHANGE_DESCRIPTION:
				const communityDesc = message.messageStubParameters?.[0]
				emitGroupUpdate({ desc: communityDesc })
				break
			case Types_1.WAMessageStubType.COMMUNITY_ALLOW_MEMBER_ADDED_GROUPS:
				emitGroupUpdate({ communityMemberAddGroupMode: message.messageStubParameters?.[0] })
				break
			case Types_1.WAMessageStubType.EMPTY_SUBGROUP_CREATE:
				emitGroupUpdate({ subject: message.messageStubParameters?.[0], isEmpty: true })
				break
			case Types_1.WAMessageStubType.COMMUNITY_DEACTIVATE_SIBLING_GROUP:
				emitGroupUpdate({ deactivated: true, linkedSibling: message.messageStubParameters?.[0] })
				break
			case Types_1.WAMessageStubType.COMMUNITY_OWNER_UPDATED:
				emitGroupUpdate({ owner: message.messageStubParameters?.[0] })
				break
			case Types_1.WAMessageStubType.COMMUNITY_SUB_GROUP_VISIBILITY_HIDDEN:
				emitGroupUpdate({ hidden: true })
				break
		}
	} else if (content?.pollUpdateMessage) {
		const creationMsgKey = content.pollUpdateMessage.pollCreationMessageKey
		const pollMsg = await getMessage(creationMsgKey)
		if (pollMsg) {
			// message may be wrapped in viewOnce or botInvoke — unwrap to find messageSecret
			const inner = pollMsg.viewOnceMessage?.message || pollMsg.botInvokeMessage?.message || pollMsg
			const pollEncKey = inner.messageContextInfo?.messageSecret || pollMsg.messageContextInfo?.messageSecret || null
			if (!pollEncKey) {
				logger?.warn({ creationMsgKey }, 'poll: messageSecret missing, cannot decrypt vote')
			} else {
				// prefer LID for pollCreatorJid; WA uses the addressing JID of the poll creator
				const rawLid = creds.me?.lid
				const meLidNorm = rawLid ? `${rawLid.split(':')[0]}@lid` : ''
				const pollCreatorJid = meLidNorm || (0, WABinary_1.jidNormalizedUser)(meId)
				// voterJid: use the primary addressing JID (LID or PN) from the update key
				const voterJid = message.key.fromMe ? pollCreatorJid : message.key.participant || message.key.remoteJid
				try {
					const voteMsg = decryptPollVote(content.pollUpdateMessage.vote, {
						pollEncKey,
						pollCreatorJid,
						pollMsgId: creationMsgKey.id,
						voterJid
					})
					ev.emit('messages.update', [
						{
							key: creationMsgKey,
							update: {
								pollUpdates: [
									{
										pollUpdateMessageKey: message.key,
										vote: voteMsg,
										senderTimestampMs: (0, generics_1.toNumber)(content.pollUpdateMessage.senderTimestampMs)
									}
								]
							}
						}
					])
				} catch (err) {
					logger?.warn({ err, creationMsgKey, pollCreatorJid, voterJid }, 'failed to decrypt poll vote')
				}
			}
		} else {
			logger?.warn({ creationMsgKey }, 'poll: creation message not found, cannot decrypt vote')
		}
	}
	if (Object.keys(chat).length > 1) {
		ev.emit('chats.update', [chat])
	}
}
exports.default = processMessage
