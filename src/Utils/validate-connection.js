'use strict'
Object.defineProperty(exports, '__esModule', { value: true })
exports.encodeSignedDeviceIdentity =
	exports.configureSuccessfulPairing =
	exports.generateRegistrationNode =
	exports.generateLoginNode =
		void 0
const boom_1 = require('@hapi/boom')
const crypto_1 = require('crypto')
const rb = require('whatsapp-rust-bridge-baron')
const index_js_1 = require('../../WAProto/index.js')
const Defaults_1 = require('../Defaults')
const WABinary_1 = require('../WABinary')
const crypto_2 = require('./crypto')
const generics_1 = require('./generics')
const signal_1 = require('./signal')
const MOBILE_PLATFORMS = new Set(['Android', 'iOS'])
const getUserAgent = config => {
	const os = config.browser[0]
	let platform, device, osVersion
	if (os === 'Android') {
		platform = index_js_1.proto.ClientPayload.UserAgent.Platform.ANDROID
		device = 'Android'
		osVersion = config.browser[2] || '15.0.0'
	} else if (os === 'iOS') {
		platform = index_js_1.proto.ClientPayload.UserAgent.Platform.IOS
		device = 'iPhone'
		osVersion = config.browser[2] || '18.0'
	} else if (config.syncFullHistory && os === 'Mac OS' && config.browser[1] === 'Desktop') {
		// WA rejects full-history Desktop pairing unless macOS advertises its native
		// platform (matching webSubPlatform=DARWIN below) instead of the generic WEB.
		platform = index_js_1.proto.ClientPayload.UserAgent.Platform.MACOS
		device = 'Desktop'
		osVersion = '0.1'
	} else {
		platform = index_js_1.proto.ClientPayload.UserAgent.Platform.WEB
		device = 'Desktop'
		osVersion = '0.1'
	}
	return {
		appVersion: {
			primary: config.version[0],
			secondary: config.version[1],
			tertiary: config.version[2]
		},
		platform,
		// WA Web (Client/Payload.js) always advertises RELEASE, not BETA — confirmed against
		// whatsapp-rust-bridge's build_base_client_payload, which documents this explicitly.
		releaseChannel: index_js_1.proto.ClientPayload.UserAgent.ReleaseChannel.RELEASE,
		osVersion,
		device,
		osBuildNumber: '0.1',
		localeLanguageIso6391: 'en',
		mnc: '000',
		mcc: '000',
		localeCountryIso31661Alpha2: config.countryCode
	}
}
const PLATFORM_MAP = {
	'Mac OS': index_js_1.proto.ClientPayload.WebInfo.WebSubPlatform.DARWIN,
	Windows: index_js_1.proto.ClientPayload.WebInfo.WebSubPlatform.WIN_HYBRID,
	Android: index_js_1.proto.ClientPayload.WebInfo.WebSubPlatform.WEB_BROWSER,
	iOS: index_js_1.proto.ClientPayload.WebInfo.WebSubPlatform.WEB_BROWSER
}
const getWebInfo = config => {
	let webSubPlatform = index_js_1.proto.ClientPayload.WebInfo.WebSubPlatform.WEB_BROWSER
	if (config.syncFullHistory && PLATFORM_MAP[config.browser[0]] && config.browser[1] === 'Desktop') {
		webSubPlatform = PLATFORM_MAP[config.browser[0]]
	}
	return { webSubPlatform }
}
const getClientPayload = config => {
	const payload = {
		connectType: index_js_1.proto.ClientPayload.ConnectType.WIFI_UNKNOWN,
		connectReason: index_js_1.proto.ClientPayload.ConnectReason.USER_ACTIVATED,
		userAgent: getUserAgent(config)
	}
	if (!MOBILE_PLATFORMS.has(config.browser[0])) {
		payload.webInfo = getWebInfo(config)
	}
	return payload
}
const generateLoginNode = (userJid, config, creds) => {
	const { user, device } = (0, WABinary_1.jidDecode)(userJid)
	// masqueradeAsPrimary: connect as device 0 so the WA server (and interop bridges)
	// route primary-device traffic — including interop messages — to this session.
	// Trade-off: the real phone (device 0 on TCP) may be kicked or see a conflict.
	const effectiveDevice = config.masqueradeAsPrimary ? 0 : device
	const payload = {
		...getClientPayload(config),
		passive: !config.masqueradeAsPrimary,
		pull: !config.masqueradeAsPrimary,
		username: +user,
		device: effectiveDevice,
		lidDbMigrated: false
	}
	// InteropData is required for Meta/FB-linked accounts (AccountType = HOSTED).
	// Populated from creds when present so the server routes interop traffic correctly.
	if (creds?.interopData?.accountId) {
		payload.interopData = {
			accountId: creds.interopData.accountId,
			token: creds.interopData.token,
			enableReadReceipts: creds.interopData.enableReadReceipts ?? true
		}
	}
	return index_js_1.proto.ClientPayload.fromObject(payload)
}
exports.generateLoginNode = generateLoginNode
const getPlatformType = platform => {
	const platformType = platform.toUpperCase()
	return index_js_1.proto.DeviceProps.PlatformType[platformType] || index_js_1.proto.DeviceProps.PlatformType.CHROME
}
const generateRegistrationNode = ({ registrationId, signedPreKey, signedIdentityKey }, config) => {
	// the app version needs to be md5 hashed
	// and passed in
	const appVersionBuf = Buffer.from(rb.md5(Buffer.from(config.version.join('.'))))
	const companion = {
		os: config.browser[0],
		platformType: getPlatformType(config.browser[1]),
		requireFullSync: config.syncFullHistory,
		historySyncConfig: {
			fullSyncDaysLimit: 30,
			fullSyncSizeMbLimit: undefined,
			storageQuotaMb: 10240,
			inlineInitialPayloadInE2EeMsg: true,
			recentSyncDaysLimit: undefined,
			// The call log history payload is bound to the Windows desktop client — advertising
			// this to the server on any other browser profile is a false capability claim
			// (confirmed against whatsapp-rust-bridge's default_history_sync_config).
			supportCallLogHistory: config.browser[0] === 'Windows',
			supportBotUserAgentChatHistory: true,
			supportCagReactionsAndPolls: true,
			supportBizHostedMsg: true,
			supportRecentSyncChunkMessageCountTuning: true,
			supportHostedGroupMsg: true,
			supportFbidBotChatHistory: true,
			supportAddOnHistorySyncMigration: undefined,
			supportMessageAssociation: true,
			supportGroupHistory: true,
			onDemandReady: undefined,
			supportGuestChat: true,
			completeOnDemandReady: undefined,
			thumbnailSyncDaysLimit: undefined,
			initialSyncMaxMessagesPerChat: undefined,
			supportManusHistory: true,
			supportHatchHistory: true,
			supportedBotChannelFbids: undefined,
			supportInlineContacts: true
		},
		version: {
			primary: 10,
			secondary: 15,
			tertiary: 7
		}
	}
	const companionProto = index_js_1.proto.DeviceProps.encode(companion).finish()
	const registerPayload = {
		...getClientPayload(config),
		passive: false,
		pull: false,
		devicePairingData: {
			buildHash: appVersionBuf,
			deviceProps: companionProto,
			eRegid: (0, generics_1.encodeBigEndian)(registrationId),
			eKeytype: Defaults_1.KEY_BUNDLE_TYPE,
			eIdent: signedIdentityKey.public,
			eSkeyId: (0, generics_1.encodeBigEndian)(signedPreKey.keyId, 3),
			eSkeyVal: signedPreKey.keyPair.public,
			eSkeySig: signedPreKey.signature
		}
	}
	return index_js_1.proto.ClientPayload.fromObject(registerPayload)
}
exports.generateRegistrationNode = generateRegistrationNode
const configureSuccessfulPairing = (stanza, { advSecretKey, signedIdentityKey, signalIdentities }) => {
	const msgId = stanza.attrs.id
	const pairSuccessNode = (0, WABinary_1.getBinaryNodeChild)(stanza, 'pair-success')
	const deviceIdentityNode = (0, WABinary_1.getBinaryNodeChild)(pairSuccessNode, 'device-identity')
	const platformNode = (0, WABinary_1.getBinaryNodeChild)(pairSuccessNode, 'platform')
	const deviceNode = (0, WABinary_1.getBinaryNodeChild)(pairSuccessNode, 'device')
	const businessNode = (0, WABinary_1.getBinaryNodeChild)(pairSuccessNode, 'biz')
	if (!deviceIdentityNode || !deviceNode) {
		throw new boom_1.Boom('Missing device-identity or device in pair success node', { data: stanza })
	}
	const bizName = businessNode?.attrs.name
	const jid = deviceNode.attrs.jid
	const lid = deviceNode.attrs.lid
	const { details, hmac, accountType } = index_js_1.proto.ADVSignedDeviceIdentityHMAC.decode(deviceIdentityNode.content)
	let hmacPrefix = Buffer.from([])
	if (accountType !== undefined && accountType === index_js_1.proto.ADVEncryptionType.HOSTED) {
		hmacPrefix = Defaults_1.WA_ADV_HOSTED_ACCOUNT_SIG_PREFIX
	}
	const advSign = (0, crypto_2.hmacSign)(Buffer.concat([hmacPrefix, details]), Buffer.from(advSecretKey, 'base64'))
	if (Buffer.compare(hmac, advSign) !== 0) {
		throw new boom_1.Boom('Invalid account signature')
	}
	const account = index_js_1.proto.ADVSignedDeviceIdentity.decode(details)
	const { accountSignatureKey, accountSignature, details: deviceDetails } = account
	const deviceIdentity = index_js_1.proto.ADVDeviceIdentity.decode(deviceDetails)
	const accountSignaturePrefix =
		deviceIdentity.deviceType === index_js_1.proto.ADVEncryptionType.HOSTED
			? Defaults_1.WA_ADV_HOSTED_ACCOUNT_SIG_PREFIX
			: Defaults_1.WA_ADV_ACCOUNT_SIG_PREFIX
	const accountMsg = Buffer.concat([accountSignaturePrefix, deviceDetails, signedIdentityKey.public])
	if (!crypto_2.Curve.verify(accountSignatureKey, accountMsg, accountSignature)) {
		throw new boom_1.Boom('Failed to verify account signature')
	}
	const deviceMsg = Buffer.concat([
		Defaults_1.WA_ADV_DEVICE_SIG_PREFIX,
		deviceDetails,
		signedIdentityKey.public,
		accountSignatureKey
	])
	account.deviceSignature = crypto_2.Curve.sign(signedIdentityKey.private, deviceMsg)
	const identity = (0, signal_1.createSignalIdentity)(lid, accountSignatureKey)
	const accountEnc = (0, exports.encodeSignedDeviceIdentity)(account, false)
	const reply = {
		tag: 'iq',
		attrs: {
			to: WABinary_1.S_WHATSAPP_NET,
			type: 'result',
			id: msgId
		},
		content: [
			{
				tag: 'pair-device-sign',
				attrs: {},
				content: [
					{
						tag: 'device-identity',
						attrs: { 'key-index': deviceIdentity.keyIndex.toString() },
						content: accountEnc
					}
				]
			}
		]
	}
	const authUpdate = {
		account,
		me: { id: jid, name: bizName, lid },
		signalIdentities: [...(signalIdentities || []), identity],
		platform: platformNode?.attrs.name
	}
	return {
		creds: authUpdate,
		reply
	}
}
exports.configureSuccessfulPairing = configureSuccessfulPairing
const encodeSignedDeviceIdentity = (account, includeSignatureKey) => {
	account = { ...account }
	// set to null if we are not to include the signature key
	// or if we are including the signature key but it is empty
	if (!includeSignatureKey || !account.accountSignatureKey?.length) {
		account.accountSignatureKey = null
	}
	return index_js_1.proto.ADVSignedDeviceIdentity.encode(account).finish()
}
exports.encodeSignedDeviceIdentity = encodeSignedDeviceIdentity
