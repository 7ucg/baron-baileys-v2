'use strict'
Object.defineProperty(exports, '__esModule', { value: true })
exports.generateWAMessage =
	exports.generateWAMessageFromContent =
	exports.generateWAMessageContent =
	exports.hasNonNullishProperty =
	exports.generateForwardMessageContent =
	exports.prepareDisappearingMessageSettingContent =
	exports.prepareWAMessageMedia =
	exports.generateLinkPreviewIfRequired =
	exports.extractUrlFromText =
		void 0
const boom_1 = require('@hapi/boom')
const crypto_1 = require('crypto')
const fs_1 = require('fs')
const lru_cache_1 = require('lru-cache')
const WAProto_1 = require('../../WAProto/index.js')
const Defaults_1 = require('../Defaults')
const Types_1 = require('../Types')
const WABinary_1 = require('../WABinary')
const crypto_2 = require('./crypto')
const generics_1 = require('./generics')
const messages_media_1 = require('./messages-media')
const reporting_utils_1 = require('./reporting-utils')
const jid_display_normalization_1 = require('./jid-display-normalization')
const message_inspect_1 = require('./message-inspect')
Object.assign(exports, message_inspect_1)
// Group-invite thumbnails are fetched (IQ + HTTP GET) per generateWAMessage call;
// caching the downloaded bytes avoids redownloading the same group picture when
// the same invite is sent to many recipients in a burst.
const groupInviteThumbnailCache = new lru_cache_1.LRUCache({ max: 100, ttl: 5 * 60 * 1000 })
const MIMETYPE_MAP = {
	image: 'image/jpeg',
	video: 'video/mp4',
	document: 'application/pdf',
	audio: 'audio/ogg; codecs=opus',
	sticker: 'image/webp',
	'product-catalog-image': 'image/jpeg'
}
const MessageTypeProto = {
	image: WAProto_1.proto.Message.ImageMessage,
	video: WAProto_1.proto.Message.VideoMessage,
	audio: WAProto_1.proto.Message.AudioMessage,
	sticker: WAProto_1.proto.Message.StickerMessage,
	document: WAProto_1.proto.Message.DocumentMessage
}

// Input payloads can carry protobuf media message keys (e.g. imageMessage).
const MEDIA_MESSAGE_TYPE_ALIASES = {
	imageMessage: 'image',
	videoMessage: 'video',
	audioMessage: 'audio',
	documentMessage: 'document',
	stickerMessage: 'sticker',
	// PTV = push-to-video (video note) payload.
	ptvMessage: 'video'
}
const MEDIA_MESSAGE_TYPE_ALIAS_KEYS = Object.keys(MEDIA_MESSAGE_TYPE_ALIASES)
const hasMediaPayload = message =>
	Defaults_1.MEDIA_KEYS.some(key => key in message) || MEDIA_MESSAGE_TYPE_ALIAS_KEYS.some(key => key in message)

const ButtonType = WAProto_1.proto.Message.ButtonsMessage.HeaderType

const RICH_RESPONSE_CODE_KEYWORDS = new Set([
	'break',
	'case',
	'catch',
	'continue',
	'debugger',
	'default',
	'delete',
	'do',
	'else',
	'finally',
	'for',
	'function',
	'if',
	'in',
	'instanceof',
	'new',
	'return',
	'switch',
	'this',
	'throw',
	'try',
	'typeof',
	'var',
	'void',
	'while',
	'with',
	'true',
	'false',
	'null',
	'undefined',
	'NaN',
	'Infinity',
	'class',
	'const',
	'let',
	'super',
	'extends',
	'export',
	'import',
	'yield',
	'static',
	'constructor',
	'of',
	'async',
	'await',
	'get',
	'set',
	'implements',
	'interface',
	'package',
	'private',
	'protected',
	'public',
	'enum',
	'throws',
	'transient'
])
const tokenizeCode = code => {
	const tokens = []
	let i = 0
	const len = code.length
	while (i < len) {
		if (/\s/.test(code[i])) {
			const start = i
			while (i < len && /\s/.test(code[i])) i++
			tokens.push({ content: code.slice(start, i), type: 'DEFAULT' })
			continue
		}
		if (code[i] === '"' || code[i] === "'" || code[i] === '`') {
			const start = i
			const quote = code[i]
			i++
			while (i < len && code[i] !== quote) {
				if (code[i] === '\\') i++
				i++
			}
			i++
			tokens.push({ content: code.slice(start, i), type: 'STR' })
			continue
		}
		if (code[i] === '/' && i + 1 < len && code[i + 1] === '/') {
			const start = i
			while (i < len && code[i] !== '\n') i++
			tokens.push({ content: code.slice(start, i), type: 'COMMENT' })
			continue
		}
		if (code[i] === '/' && i + 1 < len && code[i + 1] === '*') {
			const start = i
			i += 2
			while (i + 1 < len && !(code[i] === '*' && code[i + 1] === '/')) i++
			i += 2
			tokens.push({ content: code.slice(start, i), type: 'COMMENT' })
			continue
		}
		if (/[0-9]/.test(code[i])) {
			const start = i
			while (i < len && /[0-9.]/.test(code[i])) i++
			tokens.push({ content: code.slice(start, i), type: 'NUMBER' })
			continue
		}
		if (/[a-zA-Z_$]/.test(code[i])) {
			const start = i
			while (i < len && /[a-zA-Z0-9_$]/.test(code[i])) i++
			const word = code.slice(start, i)
			if (RICH_RESPONSE_CODE_KEYWORDS.has(word)) {
				tokens.push({ content: word, type: 'KEYWORD' })
			} else {
				let j = i
				while (j < len && /\s/.test(code[j])) j++
				tokens.push({ content: word, type: j < len && code[j] === '(' ? 'METHOD' : 'DEFAULT' })
			}
			continue
		}
		tokens.push({ content: code[i], type: 'DEFAULT' })
		i++
	}
	const merged = []
	for (const t of tokens) {
		if (merged.length && merged[merged.length - 1].type === 'DEFAULT' && t.type === 'DEFAULT') {
			merged[merged.length - 1].content += t.content
		} else {
			merged.push(t)
		}
	}
	return merged
}

/**
 * Uses a regex to test whether the string contains a URL, and returns the URL if it does.
 * @param text eg. hello https://google.com
 * @returns the URL, eg. https://google.com
 */
const extractUrlFromText = text => text.match(Defaults_1.URL_REGEX)?.[0]
exports.extractUrlFromText = extractUrlFromText
const generateLinkPreviewIfRequired = async (text, getUrlInfo, logger) => {
	const url = (0, exports.extractUrlFromText)(text)
	if (!!getUrlInfo && url) {
		try {
			const urlInfo = await getUrlInfo(url)
			return urlInfo
		} catch (error) {
			// ignore if fails
			logger?.warn({ trace: error.stack }, 'url generation failed')
		}
	}
}
exports.generateLinkPreviewIfRequired = generateLinkPreviewIfRequired
const assertColor = async color => {
	let assertedColor
	if (typeof color === 'number') {
		assertedColor = color > 0 ? color : 0xffffffff + Number(color) + 1
	} else {
		let hex = color.trim().replace('#', '')
		if (hex.length <= 6) {
			hex = 'FF' + hex.padStart(6, '0')
		}
		assertedColor = parseInt(hex, 16)
		return assertedColor
	}
}
const prepareWAMessageMedia = async (message, options) => {
	const logger = options.logger
	// AB props for feature-flagged media paths (passed via options.mediaAbProps).
	const mediaAbProps = options.mediaAbProps || null
	const getMediaProp = propName => (0, messages_media_1.getMediaProp)(mediaAbProps, propName)
	let mediaType
	for (const key of Defaults_1.MEDIA_KEYS) {
		if (key in message) {
			mediaType = key
		}
	}
	if (!mediaType) {
		throw new boom_1.Boom('Invalid media type', { statusCode: 400 })
	}
	const uploadData = {
		...message,
		media: message[mediaType]
	}
	delete uploadData[mediaType]

	// Feature B: HEVC video — when hevc_video_dual_upload is enabled, allow HEVC mimetype
	// through without forcing it to mp4. When the prop is absent we leave the existing
	// mimetype as-is (defaults are set further below).
	if (mediaType === 'video' && uploadData.mimetype) {
		const isHevc = uploadData.mimetype.includes('hevc') || uploadData.mimetype.includes('x-matroska')
		if (isHevc && !getMediaProp('hevc_video_dual_upload')) {
			// Prop not enabled: normalise to mp4 so receivers can decode it.
			uploadData.mimetype = MIMETYPE_MAP['video']
		}
		// If the prop is enabled we leave the caller-supplied HEVC mimetype intact.
	}

	// check if cacheable + generate cache key
	const cacheableKey =
		typeof uploadData.media === 'object' &&
		'url' in uploadData.media &&
		!!uploadData.media.url &&
		!!options.mediaCache &&
		mediaType + ':' + uploadData.media.url.toString()
	if (mediaType === 'document' && !uploadData.fileName) {
		uploadData.fileName = 'file'
	}
	if (!uploadData.mimetype) {
		uploadData.mimetype = MIMETYPE_MAP[mediaType]
	}
	if (cacheableKey) {
		const mediaBuff = await options.mediaCache.get(cacheableKey)
		if (mediaBuff) {
			logger?.debug({ cacheableKey }, 'got media cache hit')
			const obj = WAProto_1.proto.Message.decode(mediaBuff)
			const key = `${mediaType}Message`
			Object.assign(obj[key], { ...uploadData, media: undefined })
			return obj
		}
	}
	const isNewsletter = !!options.jid && (0, WABinary_1.isJidNewsletter)(options.jid)
	if (isNewsletter) {
		logger?.info({ key: cacheableKey }, 'Preparing raw media for newsletter')
		const { filePath, fileSha256, fileLength } = await (0, messages_media_1.getRawMediaUploadData)(
			uploadData.media,
			options.mediaTypeOverride || mediaType,
			logger
		)
		const fileSha256B64 = fileSha256.toString('base64')
		const { mediaUrl, directPath } = await options.upload(filePath, {
			fileEncSha256B64: fileSha256B64,
			mediaType: mediaType,
			timeoutMs: options.mediaUploadTimeoutMs
		})
		await fs_1.promises.unlink(filePath)
		const obj = WAProto_1.proto.Message.fromObject({
			// todo: add more support here
			[`${mediaType}Message`]: MessageTypeProto[mediaType].fromObject({
				url: mediaUrl,
				directPath,
				fileSha256,
				fileLength,
				...uploadData,
				media: undefined
			})
		})
		if (uploadData.ptv) {
			obj.ptvMessage = obj.videoMessage
			delete obj.videoMessage
		}
		if (obj.stickerMessage) {
			obj.stickerMessage.stickerSentTs = Date.now()
		}
		if (cacheableKey) {
			logger?.debug({ cacheableKey }, 'set cache')
			await options.mediaCache.set(cacheableKey, WAProto_1.proto.Message.encode(obj).finish())
		}
		return obj
	}
	const requiresDurationComputation = mediaType === 'audio' && typeof uploadData.seconds === 'undefined'
	const requiresThumbnailComputation =
		(mediaType === 'image' || mediaType === 'video') && typeof uploadData['jpegThumbnail'] === 'undefined'

	const requiresWaveformProcessing =
		mediaType === 'audio' && uploadData.ptt === true && typeof uploadData.waveform === 'undefined'
	const requiresAudioBackground = options.backgroundColor && mediaType === 'audio' && uploadData.ptt === true
	const requiresOriginalForSomeProcessing = requiresDurationComputation || requiresThumbnailComputation
	const { mediaKey, encFilePath, originalFilePath, fileEncSha256, fileSha256, fileLength } = await (0,
	messages_media_1.encryptedStream)(uploadData.media, options.mediaTypeOverride || mediaType, {
		logger,
		saveOriginalFileIfRequired: requiresOriginalForSomeProcessing,
		opts: options.options
	})
	const fileEncSha256B64 = fileEncSha256.toString('base64')
	const [{ mediaUrl, directPath }] = await Promise.all([
		(async () => {
			const result = await options.upload(encFilePath, {
				fileEncSha256B64,
				mediaType,
				timeoutMs: options.mediaUploadTimeoutMs
			})
			logger?.debug({ mediaType, cacheableKey }, 'uploaded media')
			return result
		})(),
		(async () => {
			try {
				if (requiresThumbnailComputation) {
					const { thumbnail, originalImageDimensions } = await (0, messages_media_1.generateThumbnail)(
						originalFilePath,
						mediaType,
						options
					)
					uploadData.jpegThumbnail = thumbnail
					if (!uploadData.width && originalImageDimensions) {
						uploadData.width = originalImageDimensions.width
						uploadData.height = originalImageDimensions.height
						logger?.debug('set dimensions')
					}
					logger?.debug('generated thumbnail')
				}
				if (requiresDurationComputation) {
					uploadData.seconds = await (0, messages_media_1.getAudioDuration)(originalFilePath)
					logger?.debug('computed audio duration')
				}
				if (requiresWaveformProcessing) {
					uploadData.waveform = await (0, messages_media_1.getAudioWaveform)(originalFilePath, logger)
					logger?.debug('processed waveform')
				}
				if (requiresAudioBackground) {
					uploadData.backgroundArgb = await assertColor(options.backgroundColor)
					logger?.debug('computed backgroundColor audio status')
				}
			} catch (error) {
				logger?.warn({ trace: error.stack }, 'failed to obtain extra info')
			}
		})()
	]).finally(async () => {
		try {
			await fs_1.promises.unlink(encFilePath)
			if (originalFilePath) {
				await fs_1.promises.unlink(originalFilePath)
			}
			logger?.debug('removed tmp files')
		} catch (error) {
			logger?.warn('failed to remove tmp file')
		}
	})

	// Feature A: HD image dual upload — set mediaHd flag when prop is enabled and caller
	// explicitly requests HD quality via uploadData.hd === true.
	const hdImageEnabled = mediaType === 'image' && getMediaProp('hd_image_dual_upload') && !!uploadData.hd
	const hdVideoEnabled = mediaType === 'video' && getMediaProp('hd_video_dual_upload') && !!uploadData.hd
	if (hdImageEnabled || hdVideoEnabled) {
		uploadData.mediaHd = true
		logger?.debug({ mediaType }, 'HD dual upload enabled, setting mediaHd flag')
	}

	// Feature C: Motion photo — propagate motionPhoto field for image messages when present.
	// The caller sets message.motionPhoto = true (or a Buffer for the motion data).
	if (mediaType === 'image' && uploadData.motionPhoto != null) {
		// Keep motionPhoto in uploadData; it will be spread into the proto below.
		// If it is a boolean we coerce to 1/0 for the proto field (uint32 in WA proto).
		if (typeof uploadData.motionPhoto === 'boolean') {
			uploadData.motionPhoto = uploadData.motionPhoto ? 1 : 0
		}
		logger?.debug('motion photo field set on image message')
	}

	const obj = WAProto_1.proto.Message.fromObject({
		[`${mediaType}Message`]: MessageTypeProto[mediaType].fromObject({
			url: mediaUrl,
			directPath,
			mediaKey,
			fileEncSha256,
			fileSha256,
			fileLength,
			mediaKeyTimestamp: (0, generics_1.unixTimestampSeconds)(),
			...uploadData,
			media: undefined
		})
	})
	if (uploadData.ptv) {
		obj.ptvMessage = obj.videoMessage
		delete obj.videoMessage
	}
	if (cacheableKey) {
		logger?.debug({ cacheableKey }, 'set cache')
		await options.mediaCache.set(cacheableKey, WAProto_1.proto.Message.encode(obj).finish())
	}
	return obj
}
exports.prepareWAMessageMedia = prepareWAMessageMedia
const prepareDisappearingMessageSettingContent = ephemeralExpiration => {
	ephemeralExpiration = ephemeralExpiration || 0
	const content = {
		ephemeralMessage: {
			message: {
				protocolMessage: {
					type: WAProto_1.proto.Message.ProtocolMessage.Type.EPHEMERAL_SETTING,
					ephemeralExpiration
				}
			}
		}
	}
	return WAProto_1.proto.Message.fromObject(content)
}
exports.prepareDisappearingMessageSettingContent = prepareDisappearingMessageSettingContent
/**
 * Generate forwarded message content like WA does
 * @param message the message to forward
 * @param options.forceForward will show the message as forwarded even if it is from you
 */
const generateForwardMessageContent = (message, forceForward) => {
	let content = message.message
	if (!content) {
		throw new boom_1.Boom('no content in message', { statusCode: 400 })
	}
	// hacky copy
	content = (0, exports.normalizeMessageContent)(content)
	content = WAProto_1.proto.Message.decode(WAProto_1.proto.Message.encode(content).finish())
	let key = Object.keys(content)[0]
	let score = content?.[key]?.contextInfo?.forwardingScore || 0
	score += message.key.fromMe && !forceForward ? 0 : 1
	if (key === 'conversation') {
		content.extendedTextMessage = { text: content[key] }
		delete content.conversation
		key = 'extendedTextMessage'
	}
	const key_ = content?.[key]
	if (score > 0) {
		key_.contextInfo = { forwardingScore: score, isForwarded: true }
	} else {
		key_.contextInfo = {}
	}
	return content
}
exports.generateForwardMessageContent = generateForwardMessageContent
const hasNonNullishProperty = (message, key) => {
	return (
		typeof message === 'object' &&
		message !== null &&
		key in message &&
		message[key] !== null &&
		message[key] !== undefined
	)
}
exports.hasNonNullishProperty = hasNonNullishProperty
function hasOptionalProperty(obj, key) {
	return typeof obj === 'object' && obj !== null && key in obj && obj[key] !== null
}
const normalizeEarFields = ear => {
	const result = { ...ear }
	const applyAlias = (fromKey, toKey) => {
		if (result[fromKey] !== undefined && result[toKey] === undefined) result[toKey] = result[fromKey]
	}
	applyAlias('thumbnail_url', 'thumbnailUrl')
	applyAlias('thumbnailUrl', 'thumbnail')
	applyAlias('source_url', 'sourceUrl')
	applyAlias('media_type', 'mediaType')
	applyAlias('show_ad_attribution', 'showAdAttribution')
	applyAlias('render_larger_thumbnail', 'renderLargerThumbnail')
	if (result.thumbnail && !result.jpegThumbnail) result.jpegThumbnail = result.thumbnail
	if (result.largeThumbnail !== undefined && result.renderLargerThumbnail === undefined)
		result.renderLargerThumbnail = result.largeThumbnail
	if (result.url && !result.sourceUrl) result.sourceUrl = result.url
	delete result.thumbnail
	delete result.largeThumbnail
	delete result.url
	delete result.thumbnail_url
	delete result.source_url
	delete result.media_type
	delete result.show_ad_attribution
	delete result.render_larger_thumbnail
	return result
}
const normalizeQuickReplyButton = button => {
	var _a
	if (button.name && typeof button.name === 'string') {
		return {
			name: button.name,
			buttonParamsJson:
				typeof button.buttonParamsJson === 'string'
					? button.buttonParamsJson
					: JSON.stringify(button.buttonParamsJson || {})
		}
	}
	if (button.type === 4 && button.nativeFlowInfo) {
		const { name, paramsJson } = button.nativeFlowInfo
		return {
			name: name || 'quick_reply',
			buttonParamsJson: typeof paramsJson === 'string' ? paramsJson : JSON.stringify(paramsJson || {})
		}
	}
	const buttonTextObject = button.buttonText && typeof button.buttonText === 'object' ? button.buttonText : undefined
	const displayTextCandidates = [
		button.text,
		button.displayText,
		button.display_text,
		typeof button.buttonText === 'string' ? button.buttonText : undefined,
		buttonTextObject === null || buttonTextObject === void 0 ? void 0 : buttonTextObject.displayText,
		buttonTextObject === null || buttonTextObject === void 0 ? void 0 : buttonTextObject.display_text
	]
	const displayText = displayTextCandidates.find(value => typeof value === 'string' && value.length > 0) || ''
	const id =
		button.buttonId || button.id || ((_a = button.buttonParamsJson) === null || _a === void 0 ? void 0 : _a.id) || ''
	return {
		name: 'quick_reply',
		buttonParamsJson: JSON.stringify({
			display_text: displayText,
			id
		})
	}
}
const asciiDecode = arr => arr.map(e => String.fromCharCode(e)).join('')

const applyContextInfoAndMentions = (interactiveMessage, message) => {
	if ('contextInfo' in message && !!message.contextInfo) {
		interactiveMessage.contextInfo = message.contextInfo
	}
	if ('mentions' in message && !!message.mentions) {
		interactiveMessage.contextInfo = {
			...(interactiveMessage.contextInfo || {}),
			mentionedJid: message.mentions
		}
	}
}
const buildPaymentNoteMessage = async (paymentPayload, options, fallbackText = '') => {
	let notes
	if (paymentPayload === null || paymentPayload === void 0 ? void 0 : paymentPayload.sticker) {
		const stickerPrep = await (0, exports.prepareWAMessageMedia)({ sticker: paymentPayload.sticker }, options)
		notes = {
			stickerMessage: {
				...(stickerPrep === null || stickerPrep === void 0 ? void 0 : stickerPrep.stickerMessage),
				contextInfo: paymentPayload === null || paymentPayload === void 0 ? void 0 : paymentPayload.contextInfo
			}
		}
	} else if (
		typeof (paymentPayload === null || paymentPayload === void 0 ? void 0 : paymentPayload.note) === 'string'
	) {
		notes = {
			extendedTextMessage: {
				text: paymentPayload.note,
				contextInfo: paymentPayload === null || paymentPayload === void 0 ? void 0 : paymentPayload.contextInfo
			}
		}
	} else if (
		(paymentPayload === null || paymentPayload === void 0 ? void 0 : paymentPayload.noteMessage) &&
		typeof paymentPayload.noteMessage === 'object'
	) {
		const noteKeys = Object.keys(paymentPayload.noteMessage)
		const allowedNoteMessageKeys = ['extendedTextMessage', 'stickerMessage']
		const hasOnlyAllowedKeys = noteKeys.length > 0 && noteKeys.every(key => allowedNoteMessageKeys.includes(key))
		if (!noteKeys.length || !hasOnlyAllowedKeys) {
			throw new boom_1.Boom('Invalid payment noteMessage', { statusCode: 400 })
		}
		notes = paymentPayload.noteMessage
	} else {
		notes = { extendedTextMessage: { text: fallbackText } }
	}
	return notes
}

const generateWAMessageContent = async (message, options) => {
	var _a, _b
	let m = {}
	const hasCaptionWithoutMedia = 'caption' in message && !hasMediaPayload(message)
	const hasCaptionContainer =
		('groupStatus' in message && !!message.groupStatus) || ('viewOnce' in message && !!message.viewOnce)
	if ((0, exports.hasNonNullishProperty)(message, 'text')) {
		const extContent = { text: message.text }
		let urlInfo = message.linkPreview
		if (typeof urlInfo === 'undefined') {
			urlInfo = await (0, exports.generateLinkPreviewIfRequired)(message.text, options.getUrlInfo, options.logger)
		}
		if (urlInfo) {
			extContent.matchedText = urlInfo['matched-text']
			extContent.jpegThumbnail = urlInfo.jpegThumbnail
			extContent.description = urlInfo.description
			extContent.title = urlInfo.title
			extContent.previewType = 0
			const img = urlInfo.highQualityThumbnail
			if (img) {
				extContent.thumbnailDirectPath = img.directPath
				extContent.mediaKey = img.mediaKey
				extContent.mediaKeyTimestamp = img.mediaKeyTimestamp
				extContent.thumbnailWidth = img.width
				extContent.thumbnailHeight = img.height
				extContent.thumbnailSha256 = img.fileSha256
				extContent.thumbnailEncSha256 = img.fileEncSha256
			}
		}
		if (options.backgroundColor) {
			extContent.backgroundArgb = await assertColor(options.backgroundColor)
		}
		if (options.font) {
			extContent.font = options.font
		}
		if (
			options.jid &&
			(0, WABinary_1.isInteropUser)(options.jid) &&
			!options.backgroundColor &&
			!options.font &&
			!urlInfo
		) {
			m.conversation = message.text
		} else {
			m.extendedTextMessage = extContent
		}
	} else if ((0, exports.hasNonNullishProperty)(message, 'contacts')) {
		const contactLen = message.contacts.contacts.length
		if (!contactLen) {
			throw new boom_1.Boom('require atleast 1 contact', { statusCode: 400 })
		}
		if (contactLen === 1) {
			m.contactMessage = WAProto_1.proto.Message.ContactMessage.create(message.contacts.contacts[0])
		} else {
			m.contactsArrayMessage = WAProto_1.proto.Message.ContactsArrayMessage.create(message.contacts)
		}
	} else if ((0, exports.hasNonNullishProperty)(message, 'location')) {
		m.locationMessage = WAProto_1.proto.Message.LocationMessage.create(message.location)
	} else if ((0, exports.hasNonNullishProperty)(message, 'react')) {
		if (!message.react.senderTimestampMs) {
			message.react.senderTimestampMs = Date.now()
		}
		m.reactionMessage = WAProto_1.proto.Message.ReactionMessage.create(message.react)
	} else if ((0, exports.hasNonNullishProperty)(message, 'delete')) {
		m.protocolMessage = {
			key: message.delete,
			type: WAProto_1.proto.Message.ProtocolMessage.Type.REVOKE
		}
	} else if ((0, exports.hasNonNullishProperty)(message, 'forward')) {
		m = (0, exports.generateForwardMessageContent)(message.forward, message.force)
	} else if ((0, exports.hasNonNullishProperty)(message, 'disappearingMessagesInChat')) {
		const exp =
			typeof message.disappearingMessagesInChat === 'boolean'
				? message.disappearingMessagesInChat
					? Defaults_1.WA_DEFAULT_EPHEMERAL
					: 0
				: message.disappearingMessagesInChat
		m = (0, exports.prepareDisappearingMessageSettingContent)(exp)
	} else if ((0, exports.hasNonNullishProperty)(message, 'groupInvite')) {
		m.groupInviteMessage = {}
		m.groupInviteMessage.inviteCode = message.groupInvite.inviteCode
		m.groupInviteMessage.inviteExpiration = message.groupInvite.inviteExpiration
		m.groupInviteMessage.caption = message.groupInvite.text
		m.groupInviteMessage.groupJid = message.groupInvite.jid
		m.groupInviteMessage.groupName = message.groupInvite.subject
		if (options.getProfilePicUrl) {
			const cached = groupInviteThumbnailCache.get(message.groupInvite.jid)
			if (cached) {
				m.groupInviteMessage.jpegThumbnail = cached
			} else {
				const pfpUrl = await options.getProfilePicUrl(message.groupInvite.jid, 'preview')
				if (pfpUrl) {
					const resp = await fetch(pfpUrl, { method: 'GET', dispatcher: options?.options?.dispatcher })
					if (resp.ok) {
						const buf = Buffer.from(await resp.arrayBuffer())
						m.groupInviteMessage.jpegThumbnail = buf
						groupInviteThumbnailCache.set(message.groupInvite.jid, buf)
					}
				}
			}
		}
	} else if ((0, exports.hasNonNullishProperty)(message, 'pin')) {
		m.pinInChatMessage = {}
		m.messageContextInfo = {}
		m.pinInChatMessage.key = message.pin
		m.pinInChatMessage.type = message.type
		m.pinInChatMessage.senderTimestampMs = Date.now()
		m.messageContextInfo.messageAddOnDurationInSecs = message.type === 1 ? message.time || 86400 : 0
	} else if ((0, exports.hasNonNullishProperty)(message, 'buttonReply')) {
		switch (message.type) {
			case 'template':
				m.templateButtonReplyMessage = {
					selectedDisplayText: message.buttonReply.displayText,
					selectedId: message.buttonReply.id,
					selectedIndex: message.buttonReply.index
				}
				break
			case 'plain':
				m.buttonsResponseMessage = {
					selectedButtonId: message.buttonReply.id,
					selectedDisplayText: message.buttonReply.displayText,
					type: WAProto_1.proto.Message.ButtonsResponseMessage.Type.DISPLAY_TEXT
				}
				break
			case 'interactive':
				m.interactiveResponseMessage = {
					body: {
						text: message.buttonReply.displayText,
						format: WAProto_1.proto.Message.InteractiveResponseMessage.Body.Format.EXTENSIONS_1
					},
					nativeFlowResponseMessage: {
						name: message.buttonReply.nativeFlows.name,
						paramsJson: message.buttonReply.nativeFlows.paramsJson,
						version: message.buttonReply.nativeFlows.version
					}
				}
				break
			case 'list':
				m.listResponseMessage = {
					title: message.buttonReply.title,
					description: message.buttonReply.description,
					singleSelectReply: {
						selectedRowId: message.buttonReply.rowId
					},
					listType: WAProto_1.proto.Message.ListResponseMessage.ListType.SINGLE_SELECT
				}
				break
		}
	} else if (hasOptionalProperty(message, 'ptv') && message.ptv) {
		const { videoMessage } = await (0, exports.prepareWAMessageMedia)({ video: message.video }, options)
		m.ptvMessage = videoMessage
	} else if ((0, exports.hasNonNullishProperty)(message, 'product')) {
		const { imageMessage } = await (0, exports.prepareWAMessageMedia)({ image: message.product.productImage }, options)
		m.productMessage = WAProto_1.proto.Message.ProductMessage.create({
			...message,
			product: {
				...message.product,
				productImage: imageMessage
			}
		})
	} else if ((0, exports.hasNonNullishProperty)(message, 'listReply')) {
		m.listResponseMessage = { ...message.listReply }
	} else if ((0, exports.hasNonNullishProperty)(message, 'event')) {
		m.eventMessage = {}
		const startTime = Math.floor(message.event.startDate.getTime() / 1000)
		if (message.event.call && options.getCallLink) {
			const token = await options.getCallLink(message.event.call, { startTime })
			m.eventMessage.joinLink =
				(message.event.call === 'audio' ? Defaults_1.CALL_AUDIO_PREFIX : Defaults_1.CALL_VIDEO_PREFIX) + token
		}
		m.messageContextInfo = {
			// encKey
			messageSecret: message.event.messageSecret || (0, crypto_1.randomBytes)(32)
		}
		m.eventMessage.name = message.event.name
		m.eventMessage.description = message.event.description
		m.eventMessage.startTime = startTime
		m.eventMessage.endTime = message.event.endDate ? message.event.endDate.getTime() / 1000 : undefined
		m.eventMessage.isCanceled = message.event.isCancelled ?? false
		m.eventMessage.extraGuestsAllowed = message.event.extraGuestsAllowed
		m.eventMessage.isScheduleCall = message.event.isScheduleCall ?? false
		m.eventMessage.location = message.event.location
	} else if ((0, exports.hasNonNullishProperty)(message, 'poll')) {
		;(_a = message.poll).selectableCount || (_a.selectableCount = 0)
		;(_b = message.poll).toAnnouncementGroup || (_b.toAnnouncementGroup = false)
		if (!Array.isArray(message.poll.values)) {
			throw new boom_1.Boom('Invalid poll values', { statusCode: 400 })
		}
		if (message.poll.selectableCount < 0 || message.poll.selectableCount > message.poll.values.length) {
			throw new boom_1.Boom(`poll.selectableCount in poll should be >= 0 and <= ${message.poll.values.length}`, {
				statusCode: 400
			})
		}
		m.messageContextInfo = {
			messageSecret: message.poll.messageSecret || (0, crypto_1.randomBytes)(32)
		}
		const isQuiz = message.poll.type === 'quiz' || message.poll.pollType === WAProto_1.proto.Message.PollType.QUIZ
		const pollTypeEnum = WAProto_1.proto.Message.PollType
		const pollCreationMessage = {
			name: message.poll.name,
			selectableOptionsCount: message.poll.selectableCount,
			options: message.poll.values.map(optionName => ({ optionName })),
			pollType: isQuiz ? pollTypeEnum.QUIZ : pollTypeEnum.POLL,
			...(isQuiz && message.poll.correctAnswer ? { correctAnswer: { optionName: message.poll.correctAnswer } } : {}),
			...(message.poll.endTime
				? {
						endTime:
							message.poll.endTime instanceof Date
								? Math.floor(message.poll.endTime.getTime() / 1000)
								: Number(message.poll.endTime)
					}
				: {}),
			...(message.poll.hideParticipantName !== undefined
				? { hideParticipantName: !!message.poll.hideParticipantName }
				: {}),
			...(message.poll.allowAddOption !== undefined ? { allowAddOption: !!message.poll.allowAddOption } : {}),
			// Feature D: media_poll — allow poll messages to carry a media attachment when the
			// AB prop is enabled and the caller supplies message.poll.mediaAttachment.
			...((0, messages_media_1.getMediaProp)(options.mediaAbProps, 'media_poll') && message.poll.mediaPoll != null
				? { mediaPoll: !!message.poll.mediaPoll }
				: {})
		}
		if (message.poll.version === 6 || message.poll.v6) {
			m.pollCreationMessageV6 = pollCreationMessage
		} else if (message.poll.version === 5 || message.poll.v5) {
			m.pollCreationMessageV5 = pollCreationMessage
		} else if (message.poll.toAnnouncementGroup) {
			// poll v2 is for community announcement groups (single select and multiple)
			m.pollCreationMessageV2 = pollCreationMessage
		} else {
			if (message.poll.selectableCount === 1) {
				//poll v3 is for single select polls
				m.pollCreationMessageV3 = pollCreationMessage
			} else {
				// poll for multiple choice polls
				m.pollCreationMessage = pollCreationMessage
			}
		}
	} else if ('inviteAdmin' in message) {
		m.newsletterAdminInviteMessage = {}
		m.newsletterAdminInviteMessage.inviteExpiration = message.inviteAdmin.inviteExpiration
		m.newsletterAdminInviteMessage.caption = message.inviteAdmin.text
		m.newsletterAdminInviteMessage.newsletterJid = message.inviteAdmin.jid
		m.newsletterAdminInviteMessage.newsletterName = message.inviteAdmin.subject
		m.newsletterAdminInviteMessage.jpegThumbnail = message.inviteAdmin.thumbnail
	} else if ('requestPayment' in message || 'requestPaymentMessage' in message) {
		if ('requestPayment' in message && 'requestPaymentMessage' in message) {
			throw new boom_1.Boom('Use either requestPayment or requestPaymentMessage, not both', { statusCode: 400 })
		}
		const requestPayment = message.requestPayment || message.requestPaymentMessage
		const notes = await buildPaymentNoteMessage(requestPayment, options)
		const amountValue = requestPayment.amount ?? requestPayment.amount1000
		const amount1000Raw =
			typeof (amountValue === null || amountValue === void 0 ? void 0 : amountValue.toNumber) === 'function'
				? amountValue.toNumber()
				: Number(amountValue)
		const amount1000 = Number.isFinite(amount1000Raw) ? Math.round(amount1000Raw) : amount1000Raw
		const currencyCodeIso4217 = requestPayment.currency ?? requestPayment.currencyCodeIso4217
		const requestFrom = requestPayment.from ?? requestPayment.requestFrom ?? options.recipientJid
		const missingFields = []
		if (amountValue === undefined) missingFields.push('amount/amount1000')
		if (currencyCodeIso4217 === undefined) missingFields.push('currency/currencyCodeIso4217')
		if (requestFrom === undefined) missingFields.push('from/requestFrom')
		if (missingFields.length) {
			throw new boom_1.Boom(`Invalid requestPayment fields: missing ${missingFields.join(', ')}`, { statusCode: 400 })
		}
		if (
			typeof amount1000 !== 'number' ||
			!Number.isFinite(amount1000) ||
			!Number.isInteger(amount1000) ||
			amount1000 <= 0
		) {
			throw new boom_1.Boom('Invalid requestPayment fields: amount/amount1000 must be a positive integer', {
				statusCode: 400
			})
		}
		const bg = requestPayment.background
		m.requestPaymentMessage = WAProto_1.proto.Message.RequestPaymentMessage.fromObject({
			expiryTimestamp: requestPayment.expiry ?? requestPayment.expiryTimestamp,
			amount1000,
			currencyCodeIso4217,
			requestFrom,
			noteMessage: notes,
			...(bg != null ? { background: bg } : {})
		})
	} else if ('sendPayment' in message || 'sendPaymentMessage' in message) {
		if ('sendPayment' in message && 'sendPaymentMessage' in message) {
			throw new boom_1.Boom('Use either sendPayment or sendPaymentMessage, not both', { statusCode: 400 })
		}
		const sendPayment = message.sendPayment || message.sendPaymentMessage
		const notes = await buildPaymentNoteMessage(sendPayment, options, message.text || '')
		const requestMessageKey = sendPayment.requestMessageKey ?? sendPayment.requestKey ?? sendPayment.request
		if (!requestMessageKey) {
			throw new boom_1.Boom('Invalid sendPayment fields: missing requestMessageKey/requestKey/request', {
				statusCode: 400
			})
		}
		m.sendPaymentMessage = WAProto_1.proto.Message.SendPaymentMessage.fromObject({
			noteMessage: notes,
			requestMessageKey,
			...(sendPayment.background != null ? { background: sendPayment.background } : {}),
			...(sendPayment.transactionData != null ? { transactionData: sendPayment.transactionData } : {})
		})
	} else if ('declinePaymentRequest' in message || 'declinePaymentRequestMessage' in message) {
		if ('declinePaymentRequest' in message && 'declinePaymentRequestMessage' in message) {
			throw new boom_1.Boom('Use either declinePaymentRequest or declinePaymentRequestMessage, not both', {
				statusCode: 400
			})
		}
		const declinePayment = message.declinePaymentRequest || message.declinePaymentRequestMessage
		const key = (declinePayment === null || declinePayment === void 0 ? void 0 : declinePayment.key) || declinePayment
		if (!key) {
			throw new boom_1.Boom('Invalid declinePaymentRequest fields: missing key', { statusCode: 400 })
		}
		m.declinePaymentRequestMessage = WAProto_1.proto.Message.DeclinePaymentRequestMessage.fromObject({ key })
	} else if ('cancelPaymentRequest' in message || 'cancelPaymentRequestMessage' in message) {
		if ('cancelPaymentRequest' in message && 'cancelPaymentRequestMessage' in message) {
			throw new boom_1.Boom('Use either cancelPaymentRequest or cancelPaymentRequestMessage, not both', {
				statusCode: 400
			})
		}
		const cancelPayment = message.cancelPaymentRequest || message.cancelPaymentRequestMessage
		const key = (cancelPayment === null || cancelPayment === void 0 ? void 0 : cancelPayment.key) || cancelPayment
		if (!key) {
			throw new boom_1.Boom('Invalid cancelPaymentRequest fields: missing key', { statusCode: 400 })
		}
		m.cancelPaymentRequestMessage = WAProto_1.proto.Message.CancelPaymentRequestMessage.fromObject({ key })
	} else if ('requestPaymentFrom' in message && !!message.requestPaymentFrom) {
		const noteText = message.text || ''
		m.requestPaymentMessage = WAProto_1.proto.Message.RequestPaymentMessage.fromObject({
			requestFrom: message.requestPaymentFrom,
			noteMessage: { extendedTextMessage: { text: noteText } }
		})
	} else if ('invoiceNote' in message) {
		const preparedInvoice = await (0, exports.prepareWAMessageMedia)(message, options)
		const mediaType = Object.keys(preparedInvoice)[0]
		const mediaMsg = preparedInvoice[mediaType] || {}
		m.invoiceMessage = WAProto_1.proto.Message.InvoiceMessage.fromObject({
			note: message.invoiceNote,
			token: message.invoiceToken || '',
			attachmentType: mediaType === 'imageMessage' ? 1 : 0,
			attachmentMimetype: mediaMsg.mimetype,
			attachmentMediaKey: mediaMsg.mediaKey,
			attachmentMediaKeyTimestamp: mediaMsg.mediaKeyTimestamp,
			attachmentFileSha256: mediaMsg.fileSha256,
			attachmentFileEncSha256: mediaMsg.fileEncSha256,
			attachmentDirectPath: mediaMsg.directPath,
			attachmentJpegThumbnail: mediaMsg.jpegThumbnail
		})
	} else if ('orderText' in message) {
		m.orderMessage = WAProto_1.proto.Message.OrderMessage.fromObject({
			message: message.orderText,
			thumbnail: message.thumbnail,
			status: message.orderStatus || 1,
			surface: message.orderSurface || 1
		})
	} else if ('paymentInviteServiceType' in message) {
		m.paymentInviteMessage = {
			serviceType: message.paymentInviteServiceType,
			expiryTimestamp: message.paymentInviteExpiry
		}
	} else if ((0, exports.hasNonNullishProperty)(message, 'sharePhoneNumber')) {
		m.protocolMessage = {
			type: WAProto_1.proto.Message.ProtocolMessage.Type.SHARE_PHONE_NUMBER
		}
	} else if ((0, exports.hasNonNullishProperty)(message, 'requestPhoneNumber')) {
		m.requestPhoneNumberMessage = {}
	} else if ((0, exports.hasNonNullishProperty)(message, 'limitSharing')) {
		m.protocolMessage = {
			type: WAProto_1.proto.Message.ProtocolMessage.Type.LIMIT_SHARING,
			limitSharing: {
				sharingLimited: message.limitSharing === true,
				trigger: 1,
				limitSharingSettingTimestamp: Date.now(),
				initiatedByMe: true
			}
		}
	} else if ('album' in message) {
		const imageMessages = message.album.filter(item => 'image' in item)
		const videoMessages = message.album.filter(item => 'video' in item)
		m.albumMessage = WAProto_1.proto.Message.AlbumMessage.fromObject({
			expectedImageCount: imageMessages.length,
			expectedVideoCount: videoMessages.length
		})
	} else if ('pollResult' in message) {
		if (!Array.isArray(message.pollResult.values)) {
			throw new boom_1.Boom('Invalid pollResult values', { statusCode: 400 })
		}
		const isQuizResult =
			message.pollResult.type === 'quiz' || message.pollResult.pollType === WAProto_1.proto.Message.PollType.QUIZ
		const pollVotes = message.pollResult.values.map(([optionName, optionVoteCount]) => ({
			optionName,
			optionVoteCount
		}))
		const snapshotPayload = {
			name: message.pollResult.name,
			pollVotes,
			pollType: isQuizResult ? WAProto_1.proto.Message.PollType.QUIZ : WAProto_1.proto.Message.PollType.POLL
		}
		if (message.pollResult.version === 3 || message.pollResult.v3) {
			m.pollResultSnapshotMessageV3 = WAProto_1.proto.Message.PollResultSnapshotMessage.fromObject(snapshotPayload)
		} else {
			m.pollResultSnapshotMessage = snapshotPayload
		}
	} else if ('stickerPack' in message || 'stickerPackMessage' in message) {
		if ('stickerPack' in message && 'stickerPackMessage' in message) {
			throw new boom_1.Boom('Cannot specify both stickerPack and stickerPackMessage; use only one property.', {
				statusCode: 400
			})
		}
		const stickerPackMessage = 'stickerPack' in message ? message.stickerPack : message.stickerPackMessage
		m.stickerPackMessage = WAProto_1.proto.Message.StickerPackMessage.fromObject(stickerPackMessage)
	} else if ('listMessage' in message) {
		const lm = { ...message.listMessage }
		if (lm.text !== undefined && lm.description === undefined) {
			lm.description = lm.text
			delete lm.text
		}
		m = { listMessage: lm }
	} else if ('buttonsMessage' in message) {
		m = {
			buttonsMessage: WAProto_1.proto.Message.ButtonsMessage.fromObject(message.buttonsMessage)
		}
	} else if ('interactiveMessage' in message) {
		m = { interactiveMessage: message.interactiveMessage }
	} else if ('richResponse' in message) {
		// handled in richResponse block below
	} else if ('groupStatusMessage' in message) {
		m = { groupStatusMessage: WAProto_1.proto.Message.GroupStatusMessage.fromObject(message.groupStatusMessage) }
	} else if (hasCaptionWithoutMedia && !hasCaptionContainer) {
		m.extendedTextMessage = { text: message.caption }
	} else if (hasCaptionWithoutMedia && hasCaptionContainer) {
		m = {}
	} else if (!hasCaptionWithoutMedia && hasMediaPayload(message)) {
		m = await (0, exports.prepareWAMessageMedia)(message, options)
	}
	if ('buttons' in message && !!message.buttons) {
		const interactiveMessage = {
			nativeFlowMessage: WAProto_1.proto.Message.InteractiveMessage.NativeFlowMessage.fromObject({
				buttons: message.buttons.map(normalizeQuickReplyButton)
			})
		}
		if ('text' in message) {
			interactiveMessage.body = { text: message.text }
		} else if ('caption' in message) {
			interactiveMessage.body = { text: message.caption }
			interactiveMessage.header = {
				title: message.title || '',
				subtitle: message.subtitle,
				hasMediaAttachment: Boolean(message.hasMediaAttachment)
			}
			Object.assign(interactiveMessage.header, m)
		}
		if ('title' in message && !!message.title && !interactiveMessage.header) {
			interactiveMessage.header = {
				title: message.title,
				subtitle: message.subtitle,
				hasMediaAttachment: Boolean(message.hasMediaAttachment)
			}
		} else if ('title' in message && !!message.title && interactiveMessage.header) {
			interactiveMessage.header.title = message.title
			if (message.subtitle !== undefined) {
				interactiveMessage.header.subtitle = message.subtitle
			}
		}
		if ('footer' in message && !!message.footer) {
			interactiveMessage.footer = { text: message.footer }
		}
		applyContextInfoAndMentions(interactiveMessage, message)
		m = { interactiveMessage }
	} else if ('templateButtons' in message && !!message.templateButtons) {
		const msg = {
			hydratedButtons: message.templateButtons
		}
		if ('text' in message) {
			msg.hydratedContentText = message.text
		} else {
			if ('caption' in message) {
				msg.hydratedContentText = message.caption
			}
			Object.assign(msg, m)
		}
		if ('footer' in message && !!message.footer) {
			msg.hydratedFooterText = message.footer
		}
		m = {
			templateMessage: {
				fourRowTemplate: msg,
				hydratedTemplate: msg
			}
		}
	}
	if ('sections' in message && !!message.sections) {
		const listMessage = {
			sections: message.sections,
			buttonText: message.buttonText,
			title: message.title,
			footerText: message.footer,
			description: message.text,
			listType: WAProto_1.proto.Message.ListMessage.ListType.SINGLE_SELECT
		}
		m = { listMessage }
	} else if ('productList' in message && !!message.productList) {
		if (
			!Array.isArray(message.productList) ||
			message.productList.length === 0 ||
			!Array.isArray(message.productList[0].products) ||
			message.productList[0].products.length === 0
		) {
			throw new boom_1.Boom('Invalid productList: must contain at least one section with one product', {
				statusCode: 400
			})
		}
		m.listMessage = {
			title: message.title,
			buttonText: message.buttonText,
			footerText: message.footer,
			description: message.text,
			productListInfo: {
				productSections: message.productList,
				headerImage: {
					productId: message.productList[0].products[0].productId
				},
				businessOwnerJid: message.businessOwnerJid
			},
			listType: WAProto_1.proto.Message.ListMessage.ListType.PRODUCT_LIST
		}
	}
	if ('interactiveButtons' in message && !!message.interactiveButtons) {
		const interactiveMessage = {
			nativeFlowMessage: WAProto_1.proto.Message.InteractiveMessage.NativeFlowMessage.fromObject({
				buttons: message.interactiveButtons
			})
		}
		if ('text' in message) {
			interactiveMessage.body = {
				text: message.text
			}
		} else if ('caption' in message) {
			interactiveMessage.body = {
				text: message.caption
			}
			interactiveMessage.header = {
				title: message.title,
				subtitle: message.subtitle,
				hasMediaAttachment: Boolean(message.hasMediaAttachment)
			}
			Object.assign(interactiveMessage.header, m)
		}
		if ('footer' in message && !!message.footer) {
			interactiveMessage.footer = {
				text: message.footer
			}
		}
		if ('title' in message && !!message.title) {
			interactiveMessage.header = {
				title: message.title,
				subtitle: message.subtitle,
				hasMediaAttachment: Boolean(message.hasMediaAttachment)
			}
			Object.assign(interactiveMessage.header, m)
		}
		applyContextInfoAndMentions(interactiveMessage, message)
		m = { interactiveMessage }
	}
	if ('shop' in message && !!message.shop) {
		const interactiveMessage = {
			shopStorefrontMessage: WAProto_1.proto.Message.InteractiveMessage.ShopMessage.fromObject({
				surface: (_l = message.shop) === null || _l === void 0 ? void 0 : _l.surface,
				id: (_m = message.shop) === null || _m === void 0 ? void 0 : _m.id
			})
		}
		if ('text' in message) {
			interactiveMessage.body = {
				text: message.text
			}
		} else if ('caption' in message) {
			interactiveMessage.body = {
				text: message.caption
			}
			interactiveMessage.header = {
				title: message.title,
				subtitle: message.subtitle,
				hasMediaAttachment: Boolean(message.hasMediaAttachment)
			}
			Object.assign(interactiveMessage.header, m)
		}
		if ('footer' in message && !!message.footer) {
			interactiveMessage.footer = {
				text: message.footer
			}
		}
		if ('title' in message && !!message.title) {
			interactiveMessage.header = {
				title: message.title,
				subtitle: message.subtitle,
				hasMediaAttachment: Boolean(message.hasMediaAttachment)
			}
			Object.assign(interactiveMessage.header, m)
		}
		applyContextInfoAndMentions(interactiveMessage, message)
		m = { interactiveMessage }
		if ('interactiveAsTemplate' in message && message.interactiveAsTemplate !== false) {
			m = { templateMessage: { interactiveMessageTemplate: interactiveMessage } }
		}
	}
	if ('richResponse' in message) {
		const {
			text,
			code,
			language = 'javascript',
			botJid = '259786046210223@bot',
			table,
			latex,
			map,
			imageUrl,
			imageUrls,
			responseId,
			messageSecret: richSecret
		} = message.richResponse
		const sections = []
		if (text) {
			sections.push({
				view_model: {
					primitive: { text, __typename: 'GenAIMarkdownTextUXPrimitive' },
					__typename: 'GenAISingleLayoutViewModel'
				}
			})
		}
		if (code) {
			sections.push({
				view_model: {
					primitive: {
						language,
						code_blocks: tokenizeCode(String(code)),
						__typename: 'GenAICodeUXPrimitive'
					},
					__typename: 'GenAISingleLayoutViewModel'
				}
			})
		}
		if (table && Array.isArray(table.rows)) {
			sections.push({
				view_model: {
					primitive: {
						rows: table.rows.map(row => ({
							cells: Array.isArray(row) ? row.map(c => ({ text: String(c) })) : row.cells
						})),
						__typename: 'GenAITableUXPrimitive'
					},
					__typename: 'GenAISingleLayoutViewModel'
				}
			})
		}
		if (latex) {
			const expressions = Array.isArray(latex)
				? latex.map(e => (typeof e === 'string' ? { expression: e } : e))
				: [{ expression: String(latex) }]
			sections.push({
				view_model: {
					primitive: { expressions, __typename: 'GenAILatexUXPrimitive' },
					__typename: 'GenAISingleLayoutViewModel'
				}
			})
		}
		if (map) {
			sections.push({
				view_model: {
					primitive: {
						latitude: map.latitude,
						longitude: map.longitude,
						zoom: map.zoom,
						title: map.title,
						annotations: map.annotations || [],
						__typename: 'GenAIMapUXPrimitive'
					},
					__typename: 'GenAISingleLayoutViewModel'
				}
			})
		}
		if (imageUrl) {
			sections.push({
				view_model: {
					primitive: { url: imageUrl, __typename: 'GenAIInlineImageUXPrimitive' },
					__typename: 'GenAISingleLayoutViewModel'
				}
			})
		}
		if (imageUrls && Array.isArray(imageUrls) && imageUrls.length > 0) {
			sections.push({
				view_model: {
					primitive: {
						urls: imageUrls.map(u => (typeof u === 'string' ? { url: u } : u)),
						__typename: 'GenAIGridImageUXPrimitive'
					},
					__typename: 'GenAISingleLayoutViewModel'
				}
			})
		}
		if (!sections.length && !text) {
			sections.push({
				view_model: {
					primitive: { text: '', __typename: 'GenAIMarkdownTextUXPrimitive' },
					__typename: 'GenAISingleLayoutViewModel'
				}
			})
		}
		const unifiedData = {
			response_id: responseId || (0, crypto_1.randomUUID)(),
			sections
		}
		return WAProto_1.proto.Message.fromObject({
			messageContextInfo: {
				deviceListMetadata: {},
				deviceListMetadataVersion: 2,
				messageSecret: richSecret || (0, crypto_1.randomBytes)(32)
			},
			botForwardedMessage: {
				message: {
					richResponseMessage: {
						submessages: [],
						messageType: 1,
						unifiedResponse: { data: Buffer.from(JSON.stringify(unifiedData)) },
						contextInfo: {
							forwardingScore: 2,
							isForwarded: true,
							forwardedAiBotMessageInfo: { botJid },
							botMessageSharingInfo: {
								botEntryPointOrigin: 1,
								forwardScore: 2
							}
						}
					}
				}
			}
		})
	}
	if ('statusNotification' in message || 'statusNotificationMessage' in message) {
		const notifData = 'statusNotification' in message ? message.statusNotification : message.statusNotificationMessage
		m = { statusNotificationMessage: WAProto_1.proto.Message.StatusNotificationMessage.fromObject(notifData) }
	} else if ('statusQuestionAnswer' in message || 'statusQuestionAnswerMessage' in message) {
		const qaData =
			'statusQuestionAnswer' in message ? message.statusQuestionAnswer : message.statusQuestionAnswerMessage
		m = { statusQuestionAnswerMessage: WAProto_1.proto.Message.StatusQuestionAnswerMessage.fromObject(qaData) }
	} else if ('questionResponse' in message || 'questionResponseMessage' in message) {
		const qrData = 'questionResponse' in message ? message.questionResponse : message.questionResponseMessage
		m = { questionResponseMessage: WAProto_1.proto.Message.QuestionResponseMessage.fromObject(qrData) }
	} else if ('statusQuoted' in message || 'statusQuotedMessage' in message) {
		const sqData = 'statusQuoted' in message ? message.statusQuoted : message.statusQuotedMessage
		m = { statusQuotedMessage: WAProto_1.proto.Message.StatusQuotedMessage.fromObject(sqData) }
	} else if ('statusStickerInteraction' in message || 'statusStickerInteractionMessage' in message) {
		const ssiData =
			'statusStickerInteraction' in message ? message.statusStickerInteraction : message.statusStickerInteractionMessage
		m = { statusStickerInteractionMessage: WAProto_1.proto.Message.StatusStickerInteractionMessage.fromObject(ssiData) }
	} else if ('newsletterFollowerInvite' in message || 'newsletterFollowerInviteMessageV2' in message) {
		const nfiData =
			'newsletterFollowerInvite' in message
				? message.newsletterFollowerInvite
				: message.newsletterFollowerInviteMessageV2
		m = {
			newsletterFollowerInviteMessageV2: WAProto_1.proto.Message.NewsletterFollowerInviteMessage.fromObject(nfiData)
		}
	} else if ('messageHistoryNotice' in message) {
		m = { messageHistoryNotice: WAProto_1.proto.Message.MessageHistoryNotice.fromObject(message.messageHistoryNotice) }
	} else if ('scheduledCall' in message || 'scheduledCallCreationMessage' in message) {
		if ('scheduledCall' in message && 'scheduledCallCreationMessage' in message) {
			throw new boom_1.Boom('Use either scheduledCall or scheduledCallCreationMessage, not both', { statusCode: 400 })
		}
		const sc = message.scheduledCall || message.scheduledCallCreationMessage
		const scheduledTs =
			sc.scheduledAt instanceof Date
				? sc.scheduledAt.getTime()
				: sc.scheduledAt
					? Number(sc.scheduledAt)
					: sc.scheduledTimestampMs
						? Number(sc.scheduledTimestampMs)
						: Date.now() + 3600000
		const callTypeEnum = WAProto_1.proto.Message.ScheduledCallCreationMessage.CallType
		let callType = callTypeEnum.UNKNOWN
		if (sc.isVideo || sc.callType === 'video' || sc.callType === callTypeEnum.VIDEO) {
			callType = callTypeEnum.VIDEO
		} else if (sc.callType === 'voice' || sc.callType === callTypeEnum.VOICE || sc.callType === undefined) {
			callType = callTypeEnum.VOICE
		} else {
			callType = sc.callType ?? callTypeEnum.VOICE
		}
		m.scheduledCallCreationMessage = WAProto_1.proto.Message.ScheduledCallCreationMessage.fromObject({
			scheduledTimestampMs: scheduledTs,
			callType,
			title: sc.title || ''
		})
	} else if ('editScheduledCall' in message || 'scheduledCallEditMessage' in message) {
		if ('editScheduledCall' in message && 'scheduledCallEditMessage' in message) {
			throw new boom_1.Boom('Use either editScheduledCall or scheduledCallEditMessage, not both', { statusCode: 400 })
		}
		const esc = message.editScheduledCall || message.scheduledCallEditMessage
		const key = esc.key || esc
		if (!key || typeof key !== 'object' || !key.id) {
			throw new boom_1.Boom('editScheduledCall requires a valid message key with id', { statusCode: 400 })
		}
		m.scheduledCallEditMessage = WAProto_1.proto.Message.ScheduledCallEditMessage.fromObject({
			key,
			editType: WAProto_1.proto.Message.ScheduledCallEditMessage.EditType.CANCEL
		})
	} else if ('eventInvite' in message || 'eventInviteMessage' in message) {
		if ('eventInvite' in message && 'eventInviteMessage' in message) {
			throw new boom_1.Boom('Use either eventInvite or eventInviteMessage, not both', { statusCode: 400 })
		}
		const ei = message.eventInvite || message.eventInviteMessage
		const startTime =
			ei.startDate instanceof Date
				? Math.floor(ei.startDate.getTime() / 1000)
				: ei.startTime
					? Number(ei.startTime)
					: undefined
		const endTime =
			ei.endDate instanceof Date ? Math.floor(ei.endDate.getTime() / 1000) : ei.endTime ? Number(ei.endTime) : undefined
		if (!ei.eventId && !ei.id) {
			throw new boom_1.Boom('eventInvite requires an eventId', { statusCode: 400 })
		}
		m.eventInviteMessage = WAProto_1.proto.Message.EventInviteMessage.fromObject({
			eventId: ei.eventId || ei.id,
			eventTitle: ei.title || ei.eventTitle || '',
			caption: ei.text || ei.caption || '',
			startTime,
			endTime,
			isCanceled: ei.isCancelled ?? ei.isCanceled ?? false,
			jpegThumbnail: ei.thumbnail || ei.jpegThumbnail,
			contextInfo: ei.contextInfo
		})
	} else if ('comment' in message || 'commentMessage' in message) {
		if ('comment' in message && 'commentMessage' in message) {
			throw new boom_1.Boom('Use either comment or commentMessage, not both', { statusCode: 400 })
		}
		const cm = message.comment || message.commentMessage
		if (!cm.targetMessageKey && !cm.key) {
			throw new boom_1.Boom('comment requires a targetMessageKey', { statusCode: 400 })
		}
		m.commentMessage = WAProto_1.proto.Message.CommentMessage.fromObject({
			message: cm.message || cm.replyMessage,
			targetMessageKey: cm.targetMessageKey || cm.key
		})
	} else if ('splitPayment' in message || 'splitPaymentMessage' in message) {
		if ('splitPayment' in message && 'splitPaymentMessage' in message) {
			throw new boom_1.Boom('Use either splitPayment or splitPaymentMessage, not both', { statusCode: 400 })
		}
		const sp = message.splitPayment || message.splitPaymentMessage
		if (!sp.totalAmount || !sp.participants?.length) {
			throw new boom_1.Boom('splitPayment requires totalAmount and at least one participant', { statusCode: 400 })
		}
		m.splitPaymentMessage = WAProto_1.proto.Message.SplitPaymentMessage.fromObject({
			splitId: sp.splitId || (0, crypto_1.randomUUID)(),
			totalAmount: sp.totalAmount,
			description: sp.description || '',
			requesterJid: sp.requesterJid || options.userJid,
			participants: sp.participants.map(p => ({
				jid: p.jid,
				amount: p.amount,
				status: p.status ?? WAProto_1.proto.Message.SplitPaymentParticipant.SplitPaymentStatus.PENDING
			})),
			createdAtMs: sp.createdAtMs || Date.now(),
			contextInfo: sp.contextInfo
		})
	} else if ('p2pPaymentReminder' in message || 'p2PPaymentReminderNotification' in message) {
		if ('p2pPaymentReminder' in message && 'p2PPaymentReminderNotification' in message) {
			throw new boom_1.Boom('Use either p2pPaymentReminder or p2PPaymentReminderNotification, not both', {
				statusCode: 400
			})
		}
		const pr = message.p2pPaymentReminder || message.p2PPaymentReminderNotification
		const freqEnum = WAProto_1.proto.Message.P2PPaymentReminderNotification.ReminderFrequency
		const stateEnum = WAProto_1.proto.Message.P2PPaymentReminderNotification.ReminderState
		const freqMap = {
			weekly: freqEnum.WEEKLY,
			biweekly: freqEnum.BIWEEKLY,
			monthly: freqEnum.MONTHLY,
			custom: freqEnum.CUSTOM
		}
		const stateMap = {
			active: stateEnum.ACTIVE,
			paused: stateEnum.PAUSED,
			stopped: stateEnum.STOPPED,
			expired: stateEnum.EXPIRED,
			cancelled: stateEnum.CANCELLED
		}
		m.p2PPaymentReminderNotification = WAProto_1.proto.Message.P2PPaymentReminderNotification.fromObject({
			reminderId: pr.reminderId || (0, crypto_1.randomUUID)(),
			amount: pr.amount,
			frequency:
				typeof pr.frequency === 'string'
					? (freqMap[pr.frequency.toLowerCase()] ?? freqEnum.UNKNOWN_FREQUENCY)
					: (pr.frequency ?? freqEnum.UNKNOWN_FREQUENCY),
			nextReminderTimestamp: pr.nextReminderTimestamp,
			expiryTimestamp: pr.expiryTimestamp,
			state:
				typeof pr.state === 'string'
					? (stateMap[pr.state.toLowerCase()] ?? stateEnum.ACTIVE)
					: (pr.state ?? stateEnum.ACTIVE),
			description: pr.description || '',
			creatorJid: pr.creatorJid || options.userJid,
			receiverJid: pr.receiverJid,
			upiId: pr.upiId,
			createdTimestamp: pr.createdTimestamp || Date.now()
		})
	} else if ('conditionalReveal' in message || 'conditionalRevealMessage' in message) {
		if ('conditionalReveal' in message && 'conditionalRevealMessage' in message) {
			throw new boom_1.Boom('Use either conditionalReveal or conditionalRevealMessage, not both', { statusCode: 400 })
		}
		const cr = message.conditionalReveal || message.conditionalRevealMessage
		m.conditionalRevealMessage = WAProto_1.proto.Message.ConditionalRevealMessage.fromObject({
			conditionalRevealMessageType:
				WAProto_1.proto.Message.ConditionalRevealMessage.ConditionalRevealMessageType.SCHEDULED_MESSAGE,
			revealKeyId: cr.revealKeyId || (0, crypto_1.randomUUID)()
		})
		m.messageContextInfo = {
			messageSecret: cr.messageSecret || (0, crypto_1.randomBytes)(32)
		}
	} else if ('callLog' in message || 'callLogMessage' in message) {
		if ('callLog' in message && 'callLogMessage' in message) {
			throw new boom_1.Boom('Use either callLog or callLogMessage, not both', { statusCode: 400 })
		}
		const cl = message.callLog || message.callLogMessage
		const outcomeEnum = WAProto_1.proto.Message.CallLogMessage.CallOutcome
		const callTypeEnum = WAProto_1.proto.Message.CallLogMessage.CallType
		const outcomeMap = {
			connected: outcomeEnum.CONNECTED,
			missed: outcomeEnum.MISSED,
			failed: outcomeEnum.FAILED,
			rejected: outcomeEnum.REJECTED,
			accepted_elsewhere: outcomeEnum.ACCEPTED_ELSEWHERE,
			ongoing: outcomeEnum.ONGOING,
			silenced_by_dnd: outcomeEnum.SILENCED_BY_DND,
			silenced_unknown_caller: outcomeEnum.SILENCED_UNKNOWN_CALLER
		}
		const callTypeMap = {
			regular: callTypeEnum.REGULAR,
			scheduled_call: callTypeEnum.SCHEDULED_CALL,
			voice_chat: callTypeEnum.VOICE_CHAT
		}
		m.callLogMesssage = WAProto_1.proto.Message.CallLogMessage.fromObject({
			isVideo: cl.isVideo ?? false,
			callOutcome:
				typeof cl.outcome === 'string'
					? (outcomeMap[cl.outcome.toLowerCase()] ?? outcomeEnum.CONNECTED)
					: (cl.outcome ?? outcomeEnum.CONNECTED),
			durationSecs: cl.durationSecs || 0,
			callType:
				typeof cl.callType === 'string'
					? (callTypeMap[cl.callType.toLowerCase()] ?? callTypeEnum.REGULAR)
					: (cl.callType ?? callTypeEnum.REGULAR),
			participants: (cl.participants || []).map(p => ({
				jid: p.jid,
				callOutcome:
					typeof p.outcome === 'string'
						? (outcomeMap[p.outcome.toLowerCase()] ?? outcomeEnum.CONNECTED)
						: (p.outcome ?? p.callOutcome ?? outcomeEnum.CONNECTED)
			}))
		})
	} else if ('statusMention' in message || 'statusMentionMsg' in message) {
		const sm = message.statusMention || message.statusMentionMsg
		if (!sm || typeof sm !== 'object') {
			throw new boom_1.Boom('statusMention must be an object with a message property', { statusCode: 400 })
		}
		m.statusMentionMessage = WAProto_1.proto.Message.FutureProofMessage.fromObject({
			message: sm.message || sm
		})
	} else if ('question' in message || 'questionMessage' in message) {
		const q = message.question || message.questionMessage
		m.questionMessage = WAProto_1.proto.Message.FutureProofMessage.fromObject({
			message: q.message || (typeof q === 'object' && 'conversation' in q ? q : { conversation: String(q) })
		})
	} else if ('questionReply' in message || 'questionReplyMessage' in message) {
		const qr = message.questionReply || message.questionReplyMessage
		m.questionReplyMessage = WAProto_1.proto.Message.FutureProofMessage.fromObject({
			message: qr.message || (typeof qr === 'object' && 'conversation' in qr ? qr : { conversation: String(qr) })
		})
	} else if ('statusAddYours' in message) {
		const say = message.statusAddYours
		m.statusAddYours = WAProto_1.proto.Message.FutureProofMessage.fromObject({
			message: say.message || say
		})
	} else if ('eventCoverImage' in message) {
		const eci = message.eventCoverImage
		m.eventCoverImage = WAProto_1.proto.Message.FutureProofMessage.fromObject({
			message: eci.message || eci
		})
	} else if ('spoilerMessage' in message || 'spoiler' in message) {
		const sp = message.spoilerMessage || message.spoiler
		m.spoilerMessage = WAProto_1.proto.Message.FutureProofMessage.fromObject({
			message: sp.message || sp
		})
	} else if ('lottieStickerMessage' in message || 'lottieSticker' in message) {
		const ls = message.lottieStickerMessage || message.lottieSticker
		m.lottieStickerMessage = WAProto_1.proto.Message.FutureProofMessage.fromObject({
			message: ls.message || ls
		})
	} else if ('groupStatusV2' in message || 'groupStatusMessageV2' in message) {
		const gsv2 = message.groupStatusV2 || message.groupStatusMessageV2
		m.groupStatusMessageV2 = WAProto_1.proto.Message.FutureProofMessage.fromObject({
			message: gsv2.message || gsv2
		})
	} else if ('newsletterAdminProfile' in message || 'newsletterAdminProfileMessage' in message) {
		const nap = message.newsletterAdminProfile || message.newsletterAdminProfileMessage
		m.newsletterAdminProfileMessage = WAProto_1.proto.Message.FutureProofMessage.fromObject({
			message: nap.message || nap
		})
	} else if ('newsletterAdminProfileV2' in message || 'newsletterAdminProfileMessageV2' in message) {
		const nap2 = message.newsletterAdminProfileV2 || message.newsletterAdminProfileMessageV2
		m.newsletterAdminProfileMessageV2 = WAProto_1.proto.Message.FutureProofMessage.fromObject({
			message: nap2.message || nap2
		})
	} else if ('botTask' in message || 'botTaskMessage' in message) {
		const bt = message.botTask || message.botTaskMessage
		m.botTaskMessage = WAProto_1.proto.Message.FutureProofMessage.fromObject({
			message: bt.message || bt
		})
	} else if ('botInvoke' in message || 'botInvokeMessage' in message) {
		const bi = message.botInvoke || message.botInvokeMessage
		m.botInvokeMessage = WAProto_1.proto.Message.FutureProofMessage.fromObject({
			message: bi.message || bi
		})
	} else if ('associatedChild' in message || 'associatedChildMessage' in message) {
		const ac = message.associatedChild || message.associatedChildMessage
		m.associatedChildMessage = WAProto_1.proto.Message.FutureProofMessage.fromObject({
			message: ac.message || ac
		})
	} else if ('groupStatusMention' in message || 'groupStatusMentionMessage' in message) {
		const gsm = message.groupStatusMention || message.groupStatusMentionMessage
		m.groupStatusMentionMessage = WAProto_1.proto.Message.FutureProofMessage.fromObject({
			message: gsm.message || gsm
		})
	} else if ('pollCreationOptionImage' in message || 'pollCreationOptionImageMessage' in message) {
		const pcoi = message.pollCreationOptionImage || message.pollCreationOptionImageMessage
		m.pollCreationOptionImageMessage = WAProto_1.proto.Message.FutureProofMessage.fromObject({
			message: pcoi.message || pcoi
		})
	} else if ('newsletterAdminProfileStatus' in message || 'newsletterAdminProfileStatusMessage' in message) {
		const naps = message.newsletterAdminProfileStatus || message.newsletterAdminProfileStatusMessage
		m.newsletterAdminProfileStatusMessage = WAProto_1.proto.Message.FutureProofMessage.fromObject({
			message: naps.message || naps
		})
	} else if ('placeholder' in message || 'placeholderMessage' in message) {
		const ph = message.placeholder || message.placeholderMessage
		const phTypeEnum = WAProto_1.proto.Message.PlaceholderMessage.PlaceholderType
		const phTypeMap = {
			e2e_reenable: phTypeEnum.PLACEHOLDER_MESSAGE_TYPE_E2E_REENABLE_MSG,
			linked_devices: phTypeEnum.PLACEHOLDER_MESSAGE_TYPE_LINKED_DEVICES_MESSAGE
		}
		m.placeholderMessage = WAProto_1.proto.Message.PlaceholderMessage.fromObject({
			type:
				typeof ph.type === 'string'
					? (phTypeMap[ph.type.toLowerCase()] ?? phTypeEnum.PLACEHOLDER_MESSAGE_TYPE_E2E_REENABLE_MSG)
					: (ph.type ?? phTypeEnum.PLACEHOLDER_MESSAGE_TYPE_E2E_REENABLE_MSG)
		})
	} else if ('tapLink' in message || 'tapLinkMessage' in message) {
		const tl = message.tapLink || message.tapLinkMessage
		const inner = {
			extendedTextMessage: {
				text: tl.text || tl.title || '',
				matchedText: tl.url || tl.tapUrl,
				title: tl.title || tl.text || '',
				contextInfo: {
					actionLink: {
						url: tl.url || tl.tapUrl || '',
						buttonTitle: tl.buttonTitle || 'Open'
					}
				}
			}
		}
		Object.assign(m, inner)
	} else if ('citation' in message) {
		const cit = message.citation
		m.extendedTextMessage = {
			text: cit.text || cit.title || '',
			title: cit.title || '',
			description: cit.subtitle || cit.description || '',
			...(cit.imageUrl ? { jpegThumbnail: undefined, previewType: 0 } : {})
		}
	} else if ('embeddedMusic' in message) {
		const em = message.embeddedMusic
		m.extendedTextMessage = {
			text: em.text || `🎵 ${em.title || ''} — ${em.author || ''}`,
			title: em.title || '',
			description: em.author || em.artistAttribution || '',
			previewType: 0
		}
	}
	if ('keepInChat' in message || 'keepInChatMessage' in message) {
		const kic = message.keepInChat || message.keepInChatMessage
		const keepTypeEnum = WAProto_1.proto.KeepType
		const keepTypeMap = { keep: keepTypeEnum.KEEP_FOR_ALL, undo: keepTypeEnum.UNDO_KEEP_FOR_ALL }
		m.keepInChatMessage = WAProto_1.proto.Message.KeepInChatMessage.fromObject({
			key: kic.key || kic,
			keepType:
				typeof kic.keepType === 'string'
					? (keepTypeMap[kic.keepType.toLowerCase()] ?? keepTypeEnum.KEEP_FOR_ALL)
					: (kic.keepType ?? keepTypeEnum.KEEP_FOR_ALL),
			timestampMs: kic.timestampMs || Date.now()
		})
	}
	if ('botFeedback' in message || 'botFeedbackMessage' in message) {
		const bf = message.botFeedback || message.botFeedbackMessage
		const kindEnum = WAProto_1.proto.BotFeedbackMessage.BotFeedbackKind
		const kindMap = {
			positive: kindEnum.BOT_FEEDBACK_POSITIVE,
			negative: kindEnum.BOT_FEEDBACK_NEGATIVE,
			negative_generic: kindEnum.BOT_FEEDBACK_NEGATIVE_GENERIC,
			negative_helpful: kindEnum.BOT_FEEDBACK_NEGATIVE_HELPFUL,
			negative_interesting: kindEnum.BOT_FEEDBACK_NEGATIVE_INTERESTING,
			negative_accurate: kindEnum.BOT_FEEDBACK_NEGATIVE_ACCURATE,
			negative_safe: kindEnum.BOT_FEEDBACK_NEGATIVE_SAFE,
			negative_other: kindEnum.BOT_FEEDBACK_NEGATIVE_OTHER
		}
		m.protocolMessage = {
			type: WAProto_1.proto.Message.ProtocolMessage.Type.BOT_FEEDBACK_MESSAGE,
			key: bf.key,
			botFeedbackMessage: WAProto_1.proto.BotFeedbackMessage.fromObject({
				feedbackId: bf.feedbackId || bf.key?.id || '',
				kind:
					typeof bf.kind === 'string'
						? (kindMap[bf.kind.toLowerCase()] ?? kindEnum.BOT_FEEDBACK_POSITIVE)
						: (bf.kind ?? kindEnum.BOT_FEEDBACK_POSITIVE)
			})
		}
	}
	if ('pollAddOption' in message || 'pollAddOptionMessage' in message) {
		const pao = message.pollAddOption || message.pollAddOptionMessage
		if (!pao.pollCreationMessageKey && !pao.key) {
			throw new boom_1.Boom('pollAddOption requires a pollCreationMessageKey', { statusCode: 400 })
		}
		m.pollAddOptionMessage = WAProto_1.proto.Message.PollAddOptionMessage.fromObject({
			pollCreationMessageKey: pao.pollCreationMessageKey || pao.key,
			addOption: { optionName: pao.optionName || pao.option }
		})
	}
	if ('chatTheme' in message || 'chatThemeMessage' in message) {
		const ct = message.chatTheme || message.chatThemeMessage
		const themeSetting = {
			settingTimestampMs: Date.now(),
			clearTheme: ct.clear ?? false,
			colorSchemeId: ct.colorSchemeId
		}
		if (ct.solidColor) {
			const sc = typeof ct.solidColor === 'object' ? ct.solidColor : {}
			themeSetting.solidColor = WAProto_1.proto.Message.ChatSolidColorWallpaper.fromObject({
				colorLight: sc.colorLight || sc.color || '#FFFFFF',
				colorDark: sc.colorDark || sc.color || '#000000',
				isDoodleEnabled: sc.isDoodleEnabled ?? false
			})
		} else if (ct.stockImage) {
			const si = typeof ct.stockImage === 'object' ? ct.stockImage : {}
			themeSetting.stockImage = WAProto_1.proto.Message.ChatStockImageWallpaper.fromObject({
				stockImageId: si.id || si.stockImageId || String(ct.stockImage),
				dimLevel: (si.dimLevel ?? si.opacity != null) ? (si.opacity ?? 100) / 100 : 0
			})
		} else if (ct.defaultWallpaper) {
			themeSetting.defaultWallpaper = WAProto_1.proto.Message.ChatDefaultWallpaper.fromObject({
				isDoodleEnabled: ct.defaultWallpaper.isDoodleEnabled ?? false
			})
		} else if (ct.customImage) {
			themeSetting.customImage = WAProto_1.proto.Message.ChatCustomImageWallpaper.fromObject({
				directPath: ct.customImage.directPath,
				mediaKey: ct.customImage.mediaKey,
				fileEncSha256: ct.customImage.fileEncSha256,
				fileSha256: ct.customImage.fileSha256,
				dimLevel: ct.customImage.dimLevel ?? 0
			})
		}
		m.protocolMessage = {
			type: WAProto_1.proto.Message.ProtocolMessage.Type.CHAT_THEME_SETTING,
			chatThemeSetting: WAProto_1.proto.Message.ChatThemeSetting.fromObject(themeSetting)
		}
	}
	if ('stopGeneration' in message) {
		const sg = message.stopGeneration
		m.protocolMessage = {
			type: WAProto_1.proto.Message.ProtocolMessage.Type.STOP_GENERATION_MESSAGE,
			key: sg.key || sg
		}
	}
	if ('unscheduleMessage' in message) {
		const us = message.unscheduleMessage
		m.protocolMessage = {
			type: WAProto_1.proto.Message.ProtocolMessage.Type.MESSAGE_UNSCHEDULE,
			key: us.key || us
		}
	}
	if ('bcall' in message || 'bcallMessage' in message) {
		const bc = message.bcall || message.bcallMessage
		const mediaTypeEnum = WAProto_1.proto.Message.BCallMessage.MediaType
		const mediaTypeMap = { audio: mediaTypeEnum.AUDIO, video: mediaTypeEnum.VIDEO }
		m.bcallMessage = WAProto_1.proto.Message.BCallMessage.fromObject({
			sessionId: bc.sessionId || (0, crypto_1.randomUUID)(),
			mediaType:
				typeof bc.mediaType === 'string'
					? (mediaTypeMap[bc.mediaType.toLowerCase()] ?? mediaTypeEnum.AUDIO)
					: (bc.mediaType ?? mediaTypeEnum.AUDIO),
			masterKey: bc.masterKey || (0, crypto_1.randomBytes)(32),
			caption: bc.caption || ''
		})
	}
	if ('liveLocationUpdate' in message) {
		const llu = message.liveLocationUpdate
		m.liveLocationMessage = WAProto_1.proto.Message.LiveLocationMessage.fromObject({
			degreesLatitude: llu.latitude,
			degreesLongitude: llu.longitude,
			accuracyInMeters: llu.accuracy,
			speedInMps: llu.speed,
			degreesClockwiseFromMagneticNorth: llu.heading,
			sequenceNumber: llu.sequence || 1,
			timeOffset: llu.timeOffset || 0,
			jpegThumbnail: llu.thumbnail
		})
	}
	if ('stopLiveLocation' in message) {
		const sll = message.stopLiveLocation
		m.protocolMessage = {
			type: WAProto_1.proto.Message.ProtocolMessage.Type.REVOKE,
			key: sll.key || sll
		}
	}
	if ('carousel' in message || 'carouselMessage' in message) {
		const c = message.carousel || message.carouselMessage
		if (!Array.isArray(c.cards) || !c.cards.length) {
			throw new boom_1.Boom('carousel requires at least one card', { statusCode: 400 })
		}
		const cardTypeEnum = WAProto_1.proto.Message.InteractiveMessage.CarouselMessage.CarouselCardType
		const cardTypeMap = {
			horizontal: cardTypeEnum.HSCROLL_CARDS,
			album: cardTypeEnum.ALBUM_IMAGE,
			hscroll: cardTypeEnum.HSCROLL_CARDS
		}
		m.interactiveMessage = {
			carouselMessage: WAProto_1.proto.Message.InteractiveMessage.CarouselMessage.fromObject({
				cards: c.cards.map(card => card.interactiveMessage || card),
				messageVersion: c.messageVersion || 1,
				carouselCardType:
					typeof c.cardType === 'string'
						? (cardTypeMap[c.cardType.toLowerCase()] ?? cardTypeEnum.HSCROLL_CARDS)
						: (c.carouselCardType ?? cardTypeEnum.HSCROLL_CARDS)
			})
		}
	}
	if ('aiMediaCollection' in message || 'aiMediaCollectionMessage' in message) {
		const amc = message.aiMediaCollection || message.aiMediaCollectionMessage
		m.protocolMessage = {
			type: WAProto_1.proto.Message.ProtocolMessage.Type.AI_MEDIA_COLLECTION_MESSAGE,
			aiMediaCollectionMessage: WAProto_1.proto.AIMediaCollectionMessage.fromObject({
				collectionId: amc.collectionId || (0, crypto_1.randomUUID)(),
				expectedMediaCount: amc.expectedMediaCount || amc.count || 1,
				hasGlobalCaption: amc.hasGlobalCaption ?? false
			})
		}
	}
	if ('botCapabilities' in message && Array.isArray(message.botCapabilities) && message.botCapabilities.length) {
		const capEnum = WAProto_1.proto.BotCapabilityMetadata.BotCapabilityType
		const capStrMap = Object.fromEntries(Object.entries(capEnum).map(([k, v]) => [k.toLowerCase(), v]))
		const caps = message.botCapabilities
			.map(c => (typeof c === 'string' ? (capStrMap[c.toLowerCase()] ?? capEnum.UNKNOWN) : c))
			.filter(c => typeof c === 'number' && c !== capEnum.UNKNOWN)
		m.messageContextInfo = m.messageContextInfo || {}
		m.messageContextInfo.botMetadata = WAProto_1.proto.BotMetadata.fromObject({
			capabilityMetadata: { capabilities: caps }
		})
	}
	if ('botThreadInfo' in message && message.botThreadInfo) {
		const bt = message.botThreadInfo
		const threadTypeEnum = WAProto_1.proto.AIThreadInfo.AIThreadClientInfo.AIThreadType
		const threadTypeMap = Object.fromEntries(Object.entries(threadTypeEnum).map(([k, v]) => [k.toLowerCase(), v]))
		const existing = m.messageContextInfo?.botMetadata
			? WAProto_1.proto.BotMetadata.toObject(m.messageContextInfo.botMetadata)
			: {}
		m.messageContextInfo = m.messageContextInfo || {}
		m.messageContextInfo.botMetadata = WAProto_1.proto.BotMetadata.fromObject({
			...existing,
			botThreadInfo: {
				clientInfo: {
					type:
						typeof bt.type === 'string'
							? (threadTypeMap[bt.type.toLowerCase()] ?? threadTypeEnum.UNKNOWN)
							: (bt.type ?? threadTypeEnum.UNKNOWN),
					sourceChatJid: bt.sourceChatJid || ''
				}
			}
		})
	}
	if ('messageAssociation' in message && message.messageAssociation) {
		const ma = message.messageAssociation
		const assocTypeEnum = WAProto_1.proto.MessageAssociation.AssociationType
		const assocTypeMap = Object.fromEntries(Object.entries(assocTypeEnum).map(([k, v]) => [k.toLowerCase(), v]))
		m.messageContextInfo = m.messageContextInfo || {}
		m.messageContextInfo.messageAssociation = WAProto_1.proto.MessageAssociation.fromObject({
			associationType:
				typeof ma.type === 'string'
					? (assocTypeMap[ma.type.toLowerCase()] ?? assocTypeEnum.UNKNOWN)
					: (ma.associationType ?? ma.type ?? assocTypeEnum.UNKNOWN),
			parentMessageKey: ma.parentMessageKey || ma.parentKey,
			messageIndex: ma.messageIndex || 0
		})
	}
	if ('threadId' in message && message.threadId) {
		const tid = message.threadId
		const threadTypeEnum = WAProto_1.proto.ThreadID.ThreadType
		m.messageContextInfo = m.messageContextInfo || {}
		m.messageContextInfo.threadId = [
			WAProto_1.proto.ThreadID.fromObject({
				threadType:
					tid.type === 'ai'
						? threadTypeEnum.AI_THREAD
						: tid.type === 'replies'
							? threadTypeEnum.VIEW_REPLIES
							: (tid.threadType ?? threadTypeEnum.UNKNOWN),
				threadKey: tid.key || tid.threadKey
			})
		]
	}
	if ('featureEligibilities' in message && message.featureEligibilities) {
		const fe = message.featureEligibilities
		const [msgType] = Object.keys(m)
		if (msgType && m[msgType] && typeof m[msgType] === 'object') {
			m[msgType].contextInfo = {
				...(m[msgType].contextInfo || {}),
				featureEligibilities: {
					cannotBeReactedTo: fe.cannotBeReactedTo ?? false,
					cannotBeRanked: fe.cannotBeRanked ?? false,
					canRequestFeedback: fe.canRequestFeedback ?? false,
					canBeReshared: fe.canBeReshared ?? true,
					canReceiveMultiReact: fe.canReceiveMultiReact ?? true
				}
			}
		}
	}
	if ('forwardOrigin' in message) {
		const [msgType] = Object.keys(m)
		if (msgType && m[msgType] && typeof m[msgType] === 'object') {
			const foEnum = WAProto_1.proto.ContextInfo.ForwardOrigin
			const foMap = {
				chat: foEnum.CHAT,
				status: foEnum.STATUS,
				channels: foEnum.CHANNELS,
				meta_ai: foEnum.META_AI,
				ugc: foEnum.UGC
			}
			m[msgType].contextInfo = {
				...(m[msgType].contextInfo || {}),
				forwardOrigin:
					typeof message.forwardOrigin === 'string'
						? (foMap[message.forwardOrigin.toLowerCase()] ?? foEnum.CHAT)
						: (message.forwardOrigin ?? foEnum.CHAT)
			}
		}
	}
	if ('statusAudienceMetadata' in message && message.statusAudienceMetadata) {
		const [msgType] = Object.keys(m)
		if (msgType && m[msgType] && typeof m[msgType] === 'object') {
			const audType = WAProto_1.proto.ContextInfo.StatusAudienceMetadata.AudienceType
			const sam = message.statusAudienceMetadata
			m[msgType].contextInfo = {
				...(m[msgType].contextInfo || {}),
				statusAudienceMetadata: {
					audienceType: sam.closeFriends ? audType.CLOSE_FRIENDS : audType.UNKNOWN,
					listName: sam.listName,
					listEmoji: sam.listEmoji
				}
			}
		}
	}
	if ('aiGenerated' in message && message.aiGenerated === true) {
		if (m.videoMessage) {
			m.videoMessage.videoSourceType = WAProto_1.proto.Message.VideoMessage.VideoSourceType.AI_GENERATED
		}
		if (m.imageMessage) {
			m.imageMessage.imageSourceType = WAProto_1.proto.Message.ImageMessage.ImageSourceType.AI_GENERATED
		}
	}
	if ('aiModified' in message && message.aiModified === true) {
		if (m.imageMessage) {
			m.imageMessage.imageSourceType = WAProto_1.proto.Message.ImageMessage.ImageSourceType.AI_MODIFIED
		}
	}
	if ('imageSourceType' in message) {
		if (m.imageMessage) {
			const istEnum = WAProto_1.proto.Message.ImageMessage.ImageSourceType
			const istMap = {
				user: istEnum.USER_IMAGE,
				ai_generated: istEnum.AI_GENERATED,
				ai_modified: istEnum.AI_MODIFIED,
				rasterized: istEnum.RASTERIZED_TEXT_STATUS
			}
			m.imageMessage.imageSourceType =
				typeof message.imageSourceType === 'string'
					? (istMap[message.imageSourceType.toLowerCase()] ?? istEnum.USER_IMAGE)
					: (message.imageSourceType ?? istEnum.USER_IMAGE)
		}
	}
	if ('qrUrl' in message && message.qrUrl && m.imageMessage) {
		m.imageMessage.qrUrl = message.qrUrl
	}
	if ('videoContentUrl' in message && message.videoContentUrl && m.extendedTextMessage) {
		m.extendedTextMessage.videoContentUrl = message.videoContentUrl
	}
	if ('endCardTiles' in message && Array.isArray(message.endCardTiles) && m.extendedTextMessage) {
		m.extendedTextMessage.endCardTiles = message.endCardTiles.map(tile =>
			WAProto_1.proto.Message.VideoEndCard.fromObject({
				username: tile.username || tile.user,
				caption: tile.caption || tile.text,
				thumbnailImageUrl: tile.thumbnailUrl || tile.thumbnail,
				profilePictureUrl: tile.profilePictureUrl || tile.avatar
			})
		)
	}
	if ('musicMetadata' in message && message.musicMetadata && m.extendedTextMessage) {
		const mm = message.musicMetadata
		m.extendedTextMessage.musicMetadata = WAProto_1.proto.EmbeddedMusic.fromObject({
			songId: mm.songId,
			author: mm.author || mm.artist,
			title: mm.title,
			artistAttribution: mm.artistAttribution,
			isExplicit: mm.isExplicit ?? false,
			musicSongStartTimeInMs: mm.startTimeMs || 0,
			derivedContentStartTimeInMs: mm.derivedStartTimeMs || 0,
			overlapDurationInMs: mm.overlapDurationMs || 0
		})
	}
	if ('businessInteractionPills' in message && message.businessInteractionPills) {
		const bip = message.businessInteractionPills
		const pillTypeEnum = WAProto_1.proto.ContextInfo.BusinessInteractionPills.PillType
		const entryEnum = WAProto_1.proto.ContextInfo.BusinessInteractionPills.EntryPoint
		const pillMap = Object.fromEntries(Object.entries(pillTypeEnum).map(([k, v]) => [k.toLowerCase(), v]))
		const entryMap = Object.fromEntries(Object.entries(entryEnum).map(([k, v]) => [k.toLowerCase(), v]))
		const [msgType] = Object.keys(m)
		if (msgType && m[msgType] && typeof m[msgType] === 'object') {
			m[msgType].contextInfo = {
				...(m[msgType].contextInfo || {}),
				businessInteractionPills: WAProto_1.proto.ContextInfo.BusinessInteractionPills.fromObject({
					businessJid: bip.businessJid,
					entryPoint:
						typeof bip.entryPoint === 'string'
							? (entryMap[bip.entryPoint.toLowerCase()] ?? entryEnum.ENTRY_POINT_UNKNOWN)
							: bip.entryPoint,
					pills: (bip.pills || []).map(p => ({
						pillType:
							typeof p.type === 'string'
								? (pillMap[p.type.toLowerCase()] ?? pillTypeEnum.UNKNOWN)
								: (p.pillType ?? pillTypeEnum.UNKNOWN),
						actionUrl: p.url || p.actionUrl
					}))
				})
			}
		}
	}
	if ('dataSharingContext' in message && message.dataSharingContext) {
		const dsc = message.dataSharingContext
		const [msgType] = Object.keys(m)
		if (msgType && m[msgType] && typeof m[msgType] === 'object') {
			m[msgType].contextInfo = {
				...(m[msgType].contextInfo || {}),
				dataSharingContext: WAProto_1.proto.ContextInfo.DataSharingContext.fromObject({
					showMmDisclosure: dsc.showMmDisclosure ?? false,
					encryptedSignalTokenConsented: dsc.encryptedToken,
					dataSharingFlags: dsc.flags || 0
				})
			}
		}
	}
	if ('botSession' in message && message.botSession) {
		const bs = message.botSession
		const srcEnum = WAProto_1.proto.BotSessionSource
		const srcMap = Object.fromEntries(Object.entries(srcEnum).map(([k, v]) => [k.toLowerCase(), v]))
		m.messageContextInfo = m.messageContextInfo || {}
		const existing = m.messageContextInfo.botMetadata
			? WAProto_1.proto.BotMetadata.toObject(m.messageContextInfo.botMetadata)
			: {}
		m.messageContextInfo.botMetadata = WAProto_1.proto.BotMetadata.fromObject({
			...existing,
			sessionMetadata: {
				sessionId: bs.sessionId,
				sessionSource:
					typeof bs.source === 'string'
						? (srcMap[bs.source.toLowerCase()] ?? srcEnum.NONE)
						: (bs.sessionSource ?? srcEnum.NONE)
			}
		})
	}
	if ('botReminder' in message && message.botReminder) {
		const br = message.botReminder
		const actionEnum = WAProto_1.proto.BotReminderMetadata.ReminderAction
		const freqEnum = WAProto_1.proto.BotReminderMetadata.ReminderFrequency
		const actionMap = {
			notify: actionEnum.NOTIFY,
			create: actionEnum.CREATE,
			delete: actionEnum.DELETE,
			update: actionEnum.UPDATE
		}
		const freqMap = {
			once: freqEnum.ONCE,
			daily: freqEnum.DAILY,
			weekly: freqEnum.WEEKLY,
			biweekly: freqEnum.BIWEEKLY,
			monthly: freqEnum.MONTHLY
		}
		m.messageContextInfo = m.messageContextInfo || {}
		const existing = m.messageContextInfo.botMetadata
			? WAProto_1.proto.BotMetadata.toObject(m.messageContextInfo.botMetadata)
			: {}
		m.messageContextInfo.botMetadata = WAProto_1.proto.BotMetadata.fromObject({
			...existing,
			reminderMetadata: {
				requestMessageKey: br.requestMessageKey || br.key,
				action:
					typeof br.action === 'string'
						? (actionMap[br.action.toLowerCase()] ?? actionEnum.NOTIFY)
						: (br.action ?? actionEnum.NOTIFY),
				name: br.name,
				nextTriggerTimestamp: br.nextTriggerTimestamp || br.timestamp,
				frequency:
					typeof br.frequency === 'string'
						? (freqMap[br.frequency.toLowerCase()] ?? freqEnum.ONCE)
						: (br.frequency ?? freqEnum.ONCE)
			}
		})
	}
	if ('botPlugin' in message && message.botPlugin) {
		const bp = message.botPlugin
		const ptEnum = WAProto_1.proto.BotPluginMetadata.PluginType
		const spEnum = WAProto_1.proto.BotPluginMetadata.SearchProvider
		const ptMap = { reels: ptEnum.REELS, search: ptEnum.SEARCH }
		const spMap = { bing: spEnum.BING, google: spEnum.GOOGLE, support: spEnum.SUPPORT }
		m.messageContextInfo = m.messageContextInfo || {}
		const existing = m.messageContextInfo.botMetadata
			? WAProto_1.proto.BotMetadata.toObject(m.messageContextInfo.botMetadata)
			: {}
		m.messageContextInfo.botMetadata = WAProto_1.proto.BotMetadata.fromObject({
			...existing,
			pluginMetadata: WAProto_1.proto.BotPluginMetadata.fromObject({
				provider:
					typeof bp.provider === 'string'
						? (spMap[bp.provider.toLowerCase()] ?? spEnum.UNKNOWN)
						: (bp.provider ?? spEnum.UNKNOWN),
				pluginType:
					typeof bp.pluginType === 'string'
						? (ptMap[bp.pluginType.toLowerCase()] ?? ptEnum.UNKNOWN_PLUGIN)
						: (bp.pluginType ?? ptEnum.UNKNOWN_PLUGIN),
				searchProviderUrl: bp.searchProviderUrl,
				searchQuery: bp.searchQuery,
				thumbnailCdnUrl: bp.thumbnailCdnUrl,
				profilePhotoCdnUrl: bp.profilePhotoCdnUrl,
				expectedLinksCount: bp.expectedLinksCount || 0,
				referenceIndex: bp.referenceIndex || 0
			})
		})
	}
	if ('isSpoiler' in message && message.isSpoiler === true) {
		const [msgType] = Object.keys(m)
		if (msgType && m[msgType] && typeof m[msgType] === 'object') {
			m[msgType].contextInfo = {
				...(m[msgType].contextInfo || {}),
				isSpoiler: true
			}
		}
	}
	if ('expiration' in message && typeof message.expiration === 'number') {
		const [msgType] = Object.keys(m)
		if (msgType && m[msgType] && typeof m[msgType] === 'object') {
			m[msgType].contextInfo = {
				...(m[msgType].contextInfo || {}),
				expiration: message.expiration
			}
		}
	}
	if ('ephemeralSettingTimestamp' in message) {
		const [msgType] = Object.keys(m)
		if (msgType && m[msgType] && typeof m[msgType] === 'object') {
			m[msgType].contextInfo = {
				...(m[msgType].contextInfo || {}),
				ephemeralSettingTimestamp: message.ephemeralSettingTimestamp
			}
		}
	}
	if ('groupSubject' in message && message.groupSubject) {
		const [msgType] = Object.keys(m)
		if (msgType && m[msgType] && typeof m[msgType] === 'object') {
			m[msgType].contextInfo = {
				...(m[msgType].contextInfo || {}),
				groupSubject: message.groupSubject
			}
		}
	}
	if ('parentGroupJid' in message && message.parentGroupJid) {
		const [msgType] = Object.keys(m)
		if (msgType && m[msgType] && typeof m[msgType] === 'object') {
			m[msgType].contextInfo = {
				...(m[msgType].contextInfo || {}),
				parentGroupJid: message.parentGroupJid
			}
		}
	}
	if ('memberLabel' in message && message.memberLabel) {
		const [msgType] = Object.keys(m)
		if (msgType && m[msgType] && typeof m[msgType] === 'object') {
			m[msgType].contextInfo = {
				...(m[msgType].contextInfo || {}),
				memberLabel: message.memberLabel
			}
		}
	}
	if ('trustBanner' in message && message.trustBanner) {
		const tb = message.trustBanner
		const [msgType] = Object.keys(m)
		if (msgType && m[msgType] && typeof m[msgType] === 'object') {
			m[msgType].contextInfo = {
				...(m[msgType].contextInfo || {}),
				...(tb.type != null ? { trustBannerType: tb.type } : {}),
				...(tb.action != null ? { trustBannerAction: tb.action } : {})
			}
		}
	}
	if ('entryPoint' in message && message.entryPoint) {
		const ep = message.entryPoint
		const [msgType] = Object.keys(m)
		if (msgType && m[msgType] && typeof m[msgType] === 'object') {
			m[msgType].contextInfo = {
				...(m[msgType].contextInfo || {}),
				...(ep.source ? { entryPointConversionSource: ep.source } : {}),
				...(ep.app ? { entryPointConversionApp: ep.app } : {}),
				...(ep.delaySecs != null ? { entryPointConversionDelaySeconds: ep.delaySecs } : {}),
				...(ep.externalSource ? { entryPointConversionExternalSource: ep.externalSource } : {}),
				...(ep.externalMedium ? { entryPointConversionExternalMedium: ep.externalMedium } : {})
			}
		}
	}
	if ('utm' in message && message.utm) {
		const [msgType] = Object.keys(m)
		if (msgType && m[msgType] && typeof m[msgType] === 'object') {
			m[msgType].contextInfo = {
				...(m[msgType].contextInfo || {}),
				utm: WAProto_1.proto.ContextInfo.UTMInfo.fromObject({
					utmSource: message.utm.source,
					utmCampaign: message.utm.campaign
				})
			}
		}
	}
	if ('partiallySelectedContent' in message && message.partiallySelectedContent) {
		const [msgType] = Object.keys(m)
		if (msgType && m[msgType] && typeof m[msgType] === 'object') {
			m[msgType].contextInfo = {
				...(m[msgType].contextInfo || {}),
				partiallySelectedContent: message.partiallySelectedContent
			}
		}
	}
	if ('crossAppSource' in message && message.crossAppSource) {
		const [msgType] = Object.keys(m)
		if (msgType && m[msgType] && typeof m[msgType] === 'object') {
			m[msgType].contextInfo = {
				...(m[msgType].contextInfo || {}),
				crossAppSource: message.crossAppSource
			}
		}
	}
	if ('isQuestion' in message && message.isQuestion === true) {
		const [msgType] = Object.keys(m)
		if (msgType && m[msgType] && typeof m[msgType] === 'object') {
			m[msgType].contextInfo = {
				...(m[msgType].contextInfo || {}),
				isQuestion: true
			}
		}
	}
	if ('afterReadDuration' in message && typeof message.afterReadDuration === 'number') {
		const [msgType] = Object.keys(m)
		if (msgType && m[msgType] && typeof m[msgType] === 'object') {
			m[msgType].contextInfo = {
				...(m[msgType].contextInfo || {}),
				afterReadDuration: message.afterReadDuration
			}
		}
		m.messageContextInfo = {
			...(m.messageContextInfo || {}),
			messageAddOnDurationInSecs: message.afterReadDuration,
			messageAddOnExpiryType: WAProto_1.proto.MessageContextInfo.MessageAddonExpiryType.DEPENDENT_ON_PARENT
		}
	}
	if ('raw' in message && !!message.raw) {
		const { raw: _, externalAdReply: _ear, ...rawMsg } = message
		if ('externalAdReply' in message && !!message.externalAdReply) {
			const ear = normalizeEarFields(message.externalAdReply)
			const [rawType] = Object.keys(rawMsg)
			if (rawType && rawMsg[rawType]) {
				rawMsg[rawType].contextInfo = {
					...(rawMsg[rawType].contextInfo || {}),
					externalAdReply: ear
				}
			}
		}
		return WAProto_1.proto.Message.fromObject(rawMsg)
	} else if (Object.keys(m).length === 0) {
		m = await (0, exports.prepareWAMessageMedia)(message, options)
	}

	if (hasOptionalProperty(message, 'viewOnce') && !!message.viewOnce) {
		const viewOnceVersion = message.viewOnceVersion || message.viewOnce
		if (viewOnceVersion === 'v2' || viewOnceVersion === 2) {
			m = { viewOnceMessageV2: { message: m } }
		} else if (viewOnceVersion === 'v2ext' || viewOnceVersion === 'v2extension') {
			m = { viewOnceMessageV2Extension: { message: m } }
		} else {
			m = { viewOnceMessage: { message: m } }
		}
	}
	if (hasOptionalProperty(message, 'documentWithCaption') && !!message.documentWithCaption) {
		m = { documentWithCaptionMessage: { message: m } }
	}
	if (hasOptionalProperty(message, 'ephemeral') && !!message.ephemeral) {
		m = { ephemeralMessage: { message: m } }
	}
	if (hasOptionalProperty(message, 'groupMentioned') && !!message.groupMentioned) {
		m = { groupMentionedMessage: { message: m } }
	}
	if ('groupStatus' in message && !!message.groupStatus) {
		m = { groupStatusMessage: { message: m } }
	}
	if (
		(hasOptionalProperty(message, 'mentions') && message.mentions?.length) ||
		(hasOptionalProperty(message, 'mentionAll') && message.mentionAll)
	) {
		const normalizedMentions = await (0, jid_display_normalization_1.normalizeMentionedJidsForSend)(
			message.mentions,
			options.groupData,
			options.signalRepository,
			options.logger
		)
		const messageType = Object.keys(m)[0]
		const key = m[messageType]
		if (key && 'contextInfo' in key) {
			key.contextInfo = key.contextInfo || {}
			if (normalizedMentions?.length) {
				key.contextInfo.mentionedJid = normalizedMentions
			}
			if (message.mentionAll) {
				key.contextInfo.nonJidMentions = 1
			} else if (!key) {
				key.contextInfo = {
					mentionedJid: normalizedMentions,
					nonJidMentions: message.mentionAll ? 1 : 0
				}
			}
		}
	}
	if (hasOptionalProperty(message, 'edit')) {
		m = {
			protocolMessage: {
				key: message.edit,
				editedMessage: m,
				timestampMs: Date.now(),
				type: WAProto_1.proto.Message.ProtocolMessage.Type.MESSAGE_EDIT
			}
		}
	}
	if (hasOptionalProperty(message, 'contextInfo') && !!message.contextInfo) {
		const messageType = Object.keys(m)[0]
		const key = m[messageType]
		if ('contextInfo' in key && !!key.contextInfo) {
			key.contextInfo = { ...key.contextInfo, ...message.contextInfo }
		} else if (key) {
			key.contextInfo = message.contextInfo
		}
	}
	if ((0, reporting_utils_1.shouldIncludeReportingToken)(m) && !(0, WABinary_1.isInteropUser)(options.jid)) {
		m.messageContextInfo = m.messageContextInfo || {}
		if (!m.messageContextInfo.messageSecret) {
			m.messageContextInfo.messageSecret = (0, crypto_1.randomBytes)(32)
		}
	}

	if ('externalAdReply' in message && !!message.externalAdReply) {
		const wrappers = [
			'viewOnceMessage',
			'viewOnceMessageV2',
			'viewOnceMessageV2Extension',
			'ephemeralMessage',
			'groupStatusMessage',
			'templateMessage'
		]
		const [outerType] = Object.keys(m)
		const inner = wrappers.includes(outerType) ? m[outerType].message : m
		const [innerType] = Object.keys(inner)
		const innerPayload = innerType ? inner[innerType] : undefined
		if (innerType && innerType !== 'carouselMessage' && innerPayload && typeof innerPayload === 'object') {
			const ear = normalizeEarFields(message.externalAdReply)
			innerPayload.contextInfo = {
				...(innerPayload.contextInfo || {}),
				externalAdReply: ear
			}
		}
	}
	if ('secureMetaServiceLabel' in message && !!message.secureMetaServiceLabel) {
		const [messageType] = Object.keys(m)
		m[messageType] = m[messageType] || {}
		m[messageType].contextInfo = {
			...(m[messageType].contextInfo || {}),
			secureMetaServiceLabel: 1
		}
	}

	return WAProto_1.proto.Message.create(m)
}
exports.generateWAMessageContent = generateWAMessageContent
const generateWAMessageFromContent = (jid, message, options) => {
	// set timestamp to now
	// if not specified
	if (!options.timestamp) {
		options.timestamp = new Date()
	}
	const innerMessage = (0, exports.normalizeMessageContent)(message)
	const key = (0, exports.getContentType)(innerMessage)
	const timestamp = (0, generics_1.unixTimestampSeconds)(options.timestamp)
	const { quoted, userJid } = options
	if (quoted && !(0, WABinary_1.isJidNewsletter)(jid)) {
		const participant = quoted.key.fromMe
			? userJid // TODO: Add support for LIDs
			: quoted.participant || quoted.key.participant || quoted.key.remoteJid
		let quotedMsg = (0, exports.normalizeMessageContent)(quoted.message)
		const msgType = (0, exports.getContentType)(quotedMsg)
		// strip any redundant properties
		quotedMsg = WAProto_1.proto.Message.create({ [msgType]: quotedMsg[msgType] })
		const quotedContent = quotedMsg[msgType]
		if (typeof quotedContent === 'object' && quotedContent && 'contextInfo' in quotedContent) {
			delete quotedContent.contextInfo
		}
		const contextInfo = ('contextInfo' in innerMessage[key] && innerMessage[key]?.contextInfo) || {}
		contextInfo.participant = (0, WABinary_1.jidNormalizedUser)(participant)
		contextInfo.stanzaId = quoted.key.id
		contextInfo.quotedMessage = quotedMsg
		// if a participant is quoted, then it must be a group
		// hence, remoteJid of group must also be entered
		if (jid !== quoted.key.remoteJid) {
			contextInfo.remoteJid = quoted.key.remoteJid
		}
		if (contextInfo && innerMessage[key]) {
			/* @ts-ignore */
			innerMessage[key].contextInfo = contextInfo
		}
	}
	if (
		// if we want to send a disappearing message
		!!options.ephemeralExpiration &&
		// and it's not a protocol message -- delete, toggle disappear message
		key !== 'protocolMessage' &&
		// already not converted to disappearing message
		key !== 'ephemeralMessage' &&
		// newsletters don't support ephemeral messages
		!(0, WABinary_1.isJidNewsletter)(jid)
	) {
		/* @ts-ignore */
		innerMessage[key].contextInfo = {
			...(innerMessage[key].contextInfo || {}),
			expiration: options.ephemeralExpiration || Defaults_1.WA_DEFAULT_EPHEMERAL
			//ephemeralSettingTimestamp: options.ephemeralOptions.eph_setting_ts?.toString()
		}
	}
	message = WAProto_1.proto.Message.create(message)
	const messageJSON = {
		key: {
			remoteJid: jid,
			fromMe: true,
			id: options?.messageId || (0, generics_1.generateMessageIDV2)()
		},
		message: message,
		messageTimestamp: timestamp,
		messageStubParameters: [],
		participant: (0, WABinary_1.isJidGroup)(jid) || (0, WABinary_1.isJidStatusBroadcast)(jid) ? userJid : undefined, // TODO: Add support for LIDs
		status: Types_1.WAMessageStatus.PENDING
	}
	return WAProto_1.proto.WebMessageInfo.fromObject(messageJSON)
}
exports.generateWAMessageFromContent = generateWAMessageFromContent
const generateWAMessage = async (jid, content, options) => {
	// ensure msg ID is with every log
	options.logger = options?.logger?.child({ msgId: options.messageId })
	// Pass jid in the options to generateWAMessageContent
	return (0, exports.generateWAMessageFromContent)(
		jid,
		await (0, exports.generateWAMessageContent)(content, { ...options, jid }),
		options
	)
}
exports.generateWAMessage = generateWAMessage
