'use strict'
Object.defineProperty(exports, '__esModule', { value: true })

const boom_1 = require('@hapi/boom')
const { proto } = require('../../WAProto/index.js')
const WABinary_1 = require('../WABinary')
const crypto_2 = require('./crypto')
const generics_1 = require('./generics')
const messages_media_1 = require('./messages-media')

/** Get the key to access the true type of content */
const getContentType = content => {
	if (content) {
		const keys = Object.keys(content)
		const key = keys.find(k => (k === 'conversation' || k.includes('Message')) && k !== 'senderKeyDistributionMessage')
		return key
	}
}
exports.getContentType = getContentType

/**
 * Normalizes ephemeral, view once messages to regular message content
 * Eg. image messages in ephemeral messages, in view once messages etc.
 */
const normalizeMessageContent = content => {
	if (!content) {
		return undefined
	}
	// set max iterations to prevent an infinite loop
	for (let i = 0; i < 5; i++) {
		const inner = getFutureProofMessage(content)
		if (!inner) {
			break
		}
		content = inner.message
	}
	return content
	function getFutureProofMessage(message) {
		return (
			message.ephemeralMessage ||
			message.viewOnceMessage ||
			message.documentWithCaptionMessage ||
			message.viewOnceMessageV2 ||
			message.viewOnceMessageV2Extension ||
			message.editedMessage ||
			message.groupMentionedMessage ||
			message.botInvokeMessage ||
			message.lottieStickerMessage ||
			message.eventCoverImage ||
			message.statusMentionMessage ||
			message.pollCreationOptionImageMessage ||
			message.associatedChildMessage ||
			message.groupStatusMentionMessage ||
			message.pollCreationMessageV4 ||
			message.pollCreationMessageV5 ||
			message.statusAddYours ||
			message.groupStatusMessage ||
			message.limitSharingMessage ||
			message.botTaskMessage ||
			message.questionMessage ||
			message.groupStatusMessageV2 ||
			message.botForwardedMessage ||
			message.questionReplyMessage ||
			message.newsletterAdminProfileMessage ||
			message.newsletterAdminProfileMessageV2 ||
			message.newsletterAdminProfileStatusMessage ||
			message.spoilerMessage ||
			message.groupStatusV3Message ||
			message.pollCreationMessageV6
		)
	}
}
exports.normalizeMessageContent = normalizeMessageContent

/**
 * Extract the true message content from a message
 * Eg. extracts the inner message from a disappearing message/view once message
 */
const extractMessageContent = content => {
	const extractFromTemplateMessage = msg => {
		if (msg.imageMessage) {
			return { imageMessage: msg.imageMessage }
		} else if (msg.documentMessage) {
			return { documentMessage: msg.documentMessage }
		} else if (msg.videoMessage) {
			return { videoMessage: msg.videoMessage }
		} else if (msg.locationMessage) {
			return { locationMessage: msg.locationMessage }
		} else {
			return {
				conversation:
					'contentText' in msg ? msg.contentText : 'hydratedContentText' in msg ? msg.hydratedContentText : ''
			}
		}
	}
	content = normalizeMessageContent(content)
	if (content?.buttonsMessage) {
		return extractFromTemplateMessage(content.buttonsMessage)
	}
	if (content?.templateMessage?.hydratedFourRowTemplate) {
		return extractFromTemplateMessage(content?.templateMessage?.hydratedFourRowTemplate)
	}
	if (content?.templateMessage?.hydratedTemplate) {
		return extractFromTemplateMessage(content?.templateMessage?.hydratedTemplate)
	}
	if (content?.templateMessage?.fourRowTemplate) {
		return extractFromTemplateMessage(content?.templateMessage?.fourRowTemplate)
	}
	return content
}
exports.extractMessageContent = extractMessageContent

/** Returns the device predicted by message ID */
const getDevice = id =>
	/^3A.{18}$/.test(id)
		? 'ios'
		: /^3E.{20}$/.test(id)
			? 'web'
			: /^(.{21}|.{32})$/.test(id)
				? 'android'
				: /^(3F|.{18}$)/.test(id)
					? 'desktop'
					: 'api/baileys'
exports.getDevice = getDevice

/** Upserts a receipt in the message */
const updateMessageWithReceipt = (msg, receipt) => {
	msg.userReceipt = msg.userReceipt || []
	const recp = msg.userReceipt.find(m => m.userJid === receipt.userJid)
	if (recp) {
		Object.assign(recp, receipt)
	} else {
		msg.userReceipt.push(receipt)
	}
}
exports.updateMessageWithReceipt = updateMessageWithReceipt

/** Update the message with a new reaction */
const updateMessageWithReaction = (msg, reaction) => {
	const authorID = (0, generics_1.getKeyAuthor)(reaction.key)
	const reactions = (msg.reactions || []).filter(r => (0, generics_1.getKeyAuthor)(r.key) !== authorID)
	reaction.text = reaction.text || ''
	reactions.push(reaction)
	msg.reactions = reactions
}
exports.updateMessageWithReaction = updateMessageWithReaction

/** Update the message with a new poll update */
const updateMessageWithPollUpdate = (msg, update) => {
	const authorID = (0, generics_1.getKeyAuthor)(update.pollUpdateMessageKey)
	const reactions = (msg.pollUpdates || []).filter(
		r => (0, generics_1.getKeyAuthor)(r.pollUpdateMessageKey) !== authorID
	)
	if (update.vote?.selectedOptions?.length) {
		reactions.push(update)
	}
	msg.pollUpdates = reactions
}
exports.updateMessageWithPollUpdate = updateMessageWithPollUpdate

/** Update the message with a new event response */
const updateMessageWithEventResponse = (msg, update) => {
	const authorID = (0, generics_1.getKeyAuthor)(update.eventResponseMessageKey)
	const responses = (msg.eventResponses || []).filter(
		r => (0, generics_1.getKeyAuthor)(r.eventResponseMessageKey) !== authorID
	)
	responses.push(update)
	msg.eventResponses = responses
}
exports.updateMessageWithEventResponse = updateMessageWithEventResponse

/**
 * Aggregates all poll updates in a poll.
 * @param msg the poll creation message
 * @param meId your jid
 * @returns A list of options & their voters
 */
function getAggregateVotesInPollMessage({ message, pollUpdates }, meId) {
	const opts =
		message?.pollCreationMessage?.options ||
		message?.pollCreationMessageV2?.options ||
		message?.pollCreationMessageV3?.options ||
		message?.pollCreationMessageV5?.options ||
		message?.pollCreationMessageV6?.options ||
		message?.pollCreationMessageV4?.message?.pollCreationMessage?.options ||
		message?.pollCreationMessageV4?.message?.pollCreationMessageV3?.options ||
		[]
	const voteHashMap = opts.reduce((acc, opt) => {
		const hash = (0, crypto_2.sha256)(Buffer.from(opt.optionName || '')).toString()
		acc[hash] = {
			name: opt.optionName || '',
			voters: []
		}
		return acc
	}, {})
	for (const update of pollUpdates || []) {
		const { vote } = update
		if (!vote) {
			continue
		}
		for (const option of vote.selectedOptions || []) {
			const hash = option.toString()
			let data = voteHashMap[hash]
			if (!data) {
				voteHashMap[hash] = {
					name: 'Unknown',
					voters: []
				}
				data = voteHashMap[hash]
			}
			voteHashMap[hash].voters.push((0, generics_1.getKeyAuthor)(update.pollUpdateMessageKey, meId))
		}
	}
	return Object.values(voteHashMap)
}
exports.getAggregateVotesInPollMessage = getAggregateVotesInPollMessage

/** Given a list of message keys, aggregates them by chat & sender. Useful for sending read receipts in bulk */
const aggregateMessageKeysNotFromMe = keys => {
	const keyMap = {}
	for (const { remoteJid, id, participant, fromMe, sts } of keys) {
		if (!fromMe) {
			const uqKey = `${remoteJid}:${participant || ''}`
			if (!keyMap[uqKey]) {
				keyMap[uqKey] = {
					jid: remoteJid,
					participant: participant,
					messageIds: [],
					// sts is per-message; kept only for single-message interop receipts
					sts: sts
				}
			} else if (keyMap[uqKey].sts !== sts) {
				// Multiple messages with different sts — can't aggregate a single sts
				keyMap[uqKey].sts = undefined
			}
			keyMap[uqKey].messageIds.push(id)
		}
	}
	return Object.values(keyMap)
}
exports.aggregateMessageKeysNotFromMe = aggregateMessageKeysNotFromMe

/** Check if a WebMessageInfo has a scheduled reveal time (ConditionalRevealMessage) */
const isScheduledMessage = msg => !!msg?.scheduledMessageMetadata?.scheduledTime
exports.isScheduledMessage = isScheduledMessage

/** Get scheduled reveal time of a message as a Date, or null */
const getScheduledMessageTime = msg => {
	const t = msg?.scheduledMessageMetadata?.scheduledTime
	if (!t) return null
	return new Date(Number(t) * 1000)
}
exports.getScheduledMessageTime = getScheduledMessageTime

/** Extract PaymentInfo from a WebMessageInfo (the payment status field, not the message content) */
const getMessagePaymentInfo = msg => msg?.paymentInfo || msg?.quotedPaymentInfo || null
exports.getMessagePaymentInfo = getMessagePaymentInfo

/** Get all comment metadata from a WebMessageInfo */
const getMessageCommentMetadata = msg => msg?.commentMetadata || null
exports.getMessageCommentMetadata = getMessageCommentMetadata

/** Get all message add-ons (reactions, poll updates, pins) from a WebMessageInfo */
const getMessageAddOns = msg => msg?.messageAddOns || []
exports.getMessageAddOns = getMessageAddOns

/** Get the quiz correct answer from a poll creation message, if it's a quiz */
const getPollCorrectAnswer = pollMsg => {
	const poll =
		pollMsg?.pollCreationMessage ||
		pollMsg?.pollCreationMessageV2 ||
		pollMsg?.pollCreationMessageV3 ||
		pollMsg?.pollCreationMessageV5 ||
		pollMsg?.pollCreationMessageV6
	if (!poll) return null
	const isQuiz = poll.pollType === proto.Message.PollType?.QUIZ || poll.pollType === 1
	return isQuiz ? poll.correctAnswer?.optionName || null : null
}
exports.getPollCorrectAnswer = getPollCorrectAnswer

/**
 * Aggregates all event responses in an event message.
 * @param msg the event creation message
 * @param meLid your lid
 * @returns A list of response types & their responders
 */
function getAggregateResponsesInEventMessage({ eventResponses }, meLid) {
	const responseTypes = ['GOING', 'NOT_GOING', 'MAYBE']
	const responseMap = {}

	for (const type of responseTypes) {
		responseMap[type] = {
			response: type,
			responders: []
		}
	}
	for (const update of eventResponses) {
		const { response } = update.response || {}
		const responseType = proto.Message.EventResponseMessage.EventResponseType[response]
		if (responseType !== 'UNKNOWN' && responseMap[responseType]) {
			responseMap[responseType].responders.push(generics_1.getKeyAuthor(update.eventResponseMessageKey, meLid))
		}
	}

	return Object.values(responseMap)
}
exports.getAggregateResponsesInEventMessage = getAggregateResponsesInEventMessage

const REUPLOAD_REQUIRED_STATUS = [410, 404]

/** Downloads the given message. Throws an error if it's not a media message */
const downloadMediaMessage = async (message, type, options, ctx) => {
	const result = await downloadMsg().catch(async error => {
		// getHttpStream throws a Boom, which exposes the HTTP status on output.statusCode
		// rather than error.status — without this fallback, transport failures never
		// trigger a reupload and just propagate as a raw fetch error.
		const errorStatus =
			typeof error?.status === 'number'
				? error.status
				: typeof error?.output?.statusCode === 'number'
					? error.output.statusCode
					: undefined
		if (ctx && typeof errorStatus === 'number' && REUPLOAD_REQUIRED_STATUS.includes(errorStatus)) {
			ctx.logger.info({ key: message.key }, 'sending reupload media request...')
			message = await ctx.reuploadRequest(message)
			const result = await downloadMsg()
			return result
		}
		throw error
	})
	return result
	async function downloadMsg() {
		const mContent = extractMessageContent(message.message)
		if (!mContent) {
			throw new boom_1.Boom('No message present', { statusCode: 400, data: message })
		}
		const contentType = getContentType(mContent)
		let mediaType = contentType?.replace('Message', '')
		const media = mContent[contentType]
		if (!media || typeof media !== 'object' || (!('url' in media) && !('thumbnailDirectPath' in media))) {
			throw new boom_1.Boom(`"${contentType}" message is not a media message`)
		}
		let download
		if ('thumbnailDirectPath' in media && !('url' in media)) {
			download = {
				directPath: media.thumbnailDirectPath,
				mediaKey: media.mediaKey
			}
			mediaType = 'thumbnail-link'
		} else {
			download = media
		}
		const stream = await (0, messages_media_1.downloadContentFromMessage)(download, mediaType, options)
		if (type === 'buffer') {
			const bufferArray = []
			for await (const chunk of stream) {
				bufferArray.push(chunk)
			}
			return Buffer.concat(bufferArray)
		}
		return stream
	}
}
exports.downloadMediaMessage = downloadMediaMessage

/** Checks whether the given message is a media message; if it is returns the inner content */
const assertMediaContent = content => {
	content = extractMessageContent(content)
	const mediaContent =
		content?.documentMessage ||
		content?.imageMessage ||
		content?.videoMessage ||
		content?.audioMessage ||
		content?.stickerMessage
	if (!mediaContent) {
		throw new boom_1.Boom('given message is not a media message', { statusCode: 400, data: content })
	}
	return mediaContent
}
exports.assertMediaContent = assertMediaContent

/** Normalizes a bare user id to @s.whatsapp.net. Does not convert LID↔PN; use lidMapping / PN in key.remoteJidAlt when needed. */
const toJid = id => {
	if (!id) return ''
	if (id.includes('@')) return id
	return `${id}@s.whatsapp.net`
}
exports.toJid = toJid

/** Returns the peer LID JID when the key is LID-primary (decode sets remoteJid/participant to @lid when WA sends LID). */
const getSenderLid = message => {
	const k = message.key
	if (!k) {
		return { jid: '', lid: '' }
	}
	const jid = k.participant || k.remoteJid || ''
	if (jid.endsWith('@lid') || jid.endsWith('@hosted.lid')) {
		return { jid, lid: jid }
	}
	if (k.lid && typeof k.lid === 'string') {
		const lid = k.lid.includes('@') ? k.lid : (0, WABinary_1.jidEncode)(k.lid, 'lid')
		return { jid, lid }
	}
	if (k.participantLid && (0, WABinary_1.isLidUser)(k.participantLid)) {
		return { jid, lid: k.participantLid }
	}
	return { jid, lid: '' }
}
exports.getSenderLid = getSenderLid
