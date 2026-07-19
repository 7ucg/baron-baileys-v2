'use strict'
var __importDefault =
	(this && this.__importDefault) ||
	function (mod) {
		return mod && mod.__esModule ? mod : { default: mod }
	}
Object.defineProperty(exports, '__esModule', { value: true })
exports.VERSION =
	exports.TimeMs =
	exports.DEFAULT_CACHE_TTLS =
	exports.MIN_UPLOAD_INTERVAL =
	exports.UPLOAD_TIMEOUT =
	exports.INITIAL_PREKEY_COUNT =
	exports.MIN_PREKEY_COUNT =
	exports.MEDIA_KEYS =
	exports.MEDIA_HKDF_KEY_MAPPING =
	exports.MEDIA_PATH_MAP =
	exports.DEFAULT_CONNECTION_CONFIG =
	exports.PROCESSABLE_HISTORY_TYPES =
	exports.WA_CERT_DETAILS =
	exports.URL_REGEX =
	exports.NOISE_WA_HEADER =
	exports.KEY_BUNDLE_TYPE =
	exports.DICT_VERSION =
	exports.NOISE_MODE =
	exports.PLACEHOLDER_MAX_AGE_SECONDS =
	exports.STATUS_EXPIRY_SECONDS =
	exports.WA_DEFAULT_EPHEMERAL =
	exports.WA_ADV_HOSTED_KEY_INDEX_LIST_SIG_PREFIX =
	exports.WA_ADV_KEY_INDEX_LIST_SIG_PREFIX =
	exports.WA_ADV_HOSTED_DEVICE_SIG_PREFIX =
	exports.WA_ADV_HOSTED_ACCOUNT_SIG_PREFIX =
	exports.WA_ADV_DEVICE_SIG_PREFIX =
	exports.WA_ADV_ACCOUNT_SIG_PREFIX =
	exports.PHONE_CONNECTION_CB =
	exports.DEF_TAG_PREFIX =
	exports.DEF_CALLBACK_PREFIX =
	exports.CALL_AUDIO_PREFIX =
	exports.CALL_VIDEO_PREFIX =
	exports.DEFAULT_ORIGIN =
	exports.UNAUTHORIZED_CODES =
		void 0
const index_js_1 = require('../../WAProto/index.js')
const libsignal_1 = require('../Signal/libsignal')
const browser_utils_1 = require('../Utils/browser-utils')
const logger_1 = __importDefault(require('../Utils/logger'))
// [major, 3000, client_revision] — client_revision is fetched from web.whatsapp.com/sw.js
const version = [2, 3000, 1043437050]
exports.VERSION = version
exports.UNAUTHORIZED_CODES = [401, 403, 419]
exports.DEFAULT_ORIGIN = 'https://web.whatsapp.com'
exports.CALL_VIDEO_PREFIX = 'https://call.whatsapp.com/video/'
exports.CALL_AUDIO_PREFIX = 'https://call.whatsapp.com/voice/'
exports.DEF_CALLBACK_PREFIX = 'CB:'
exports.DEF_TAG_PREFIX = 'TAG:'
exports.PHONE_CONNECTION_CB = 'CB:Pong'
exports.WA_ADV_ACCOUNT_SIG_PREFIX = Buffer.from([6, 0])
exports.WA_ADV_DEVICE_SIG_PREFIX = Buffer.from([6, 1])
exports.WA_ADV_HOSTED_ACCOUNT_SIG_PREFIX = Buffer.from([6, 5])
exports.WA_ADV_HOSTED_DEVICE_SIG_PREFIX = Buffer.from([6, 6])
// Prefix for the key-index-list ADV signature (CompanionDeviceAdvUtil, C08C.A0J / A0K)
exports.WA_ADV_KEY_INDEX_LIST_SIG_PREFIX = Buffer.from([6, 2])
exports.WA_ADV_HOSTED_KEY_INDEX_LIST_SIG_PREFIX = Buffer.from([6, 7])
exports.WA_DEFAULT_EPHEMERAL = 7 * 24 * 60 * 60
/** Status messages older than 24 hours are considered expired */
exports.STATUS_EXPIRY_SECONDS = 24 * 60 * 60
/** WA Web enforces a 14-day maximum age for placeholder resend requests */
exports.PLACEHOLDER_MAX_AGE_SECONDS = 14 * 24 * 60 * 60
exports.NOISE_MODE = 'Noise_XX_25519_AESGCM_SHA256\0\0\0\0'
exports.DICT_VERSION = 3
exports.KEY_BUNDLE_TYPE = Buffer.from([5])
exports.NOISE_WA_HEADER = Buffer.from([87, 65, 6, exports.DICT_VERSION]) // last is "DICT_VERSION"
/** from: https://stackoverflow.com/questions/3809401/what-is-a-good-regular-expression-to-match-a-url */
exports.URL_REGEX = /https:\/\/(?![^:@\/\s]+:[^:@\/\s]+@)[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(:\d+)?(\/[^\s]*)?/g
exports.WA_CERT_DETAILS = {
	SERIAL: 0,
	ISSUER: 'WhatsAppLongTerm1',
	PUBLIC_KEY: Buffer.from('142375574d0a587166aae71ebe516437c4a28b73e3695c6ce1f7f9545da8ee6b', 'hex')
}
exports.HISTORY_SYNC_PAUSED_TIMEOUT_MS = 120000
exports.PROCESSABLE_HISTORY_TYPES = [
	index_js_1.proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP,
	index_js_1.proto.HistorySync.HistorySyncType.PUSH_NAME,
	index_js_1.proto.HistorySync.HistorySyncType.RECENT,
	index_js_1.proto.HistorySync.HistorySyncType.FULL,
	index_js_1.proto.HistorySync.HistorySyncType.ON_DEMAND,
	index_js_1.proto.HistorySync.HistorySyncType.NON_BLOCKING_DATA,
	index_js_1.proto.HistorySync.HistorySyncType.INITIAL_STATUS_V3
]
exports.DEFAULT_CONNECTION_CONFIG = {
	version: version,
	browser: browser_utils_1.Browsers.windows('Firefox'),
	waWebSocketUrl: 'wss://web.whatsapp.com/ws/chat',
	connectTimeoutMs: 20000,
	keepAliveIntervalMs: 30000,
	logger: logger_1.default.child({ class: 'baileys' }),
	emitOwnEvents: true,
	defaultQueryTimeoutMs: 60000,
	customUploadHosts: [],
	retryRequestDelayMs: 250,
	maxMsgRetryCount: 5,
	fireInitQueries: true,
	auth: undefined,
	markOnlineOnConnect: true,
	syncFullHistory: false,
	patchMessageBeforeSending: msg => msg,
	shouldSyncHistoryMessage: ({ syncType }) => {
		return syncType !== index_js_1.proto.HistorySync.HistorySyncType.FULL
	},
	shouldIgnoreJid: () => false,
	// NOT IMPLEMENTED: receiving interop messages (BirdyChat/Haiket) is not yet supported.
	// The interop bridge only establishes a Signal session with device 0 (the primary phone).
	// Companion devices (any device != 0) never receive interop messages directly — no fan-out.
	// masqueradeAsPrimary: true only works when Baileys is registered as the primary (no phone).
	// With an existing phone account the server rejects it (401) because the noise key is bound
	// to a companion slot and cannot be re-mapped to device 0 after registration.
	masqueradeAsPrimary: false,
	linkPreviewImageThumbnailWidth: 192,
	transactionOpts: { maxCommitRetries: 10, delayBetweenTriesMs: 3000 },
	generateHighQualityLinkPreview: false,
	enableAutoSessionRecreation: true,
	enableRecentMessageCache: true,
	options: {},
	appStateMacVerification: {
		patch: false,
		snapshot: false
	},
	countryCode: 'US',
	getMessage: async () => undefined,
	cachedGroupMetadata: async () => undefined,
	makeSignalRepository: libsignal_1.makeLibSignalRepository,
	maxConcurrentUploads: 3,
	presenceUpdateIntervalMs: 5000,
	groupMetadataCacheTTL: 30 * 60 * 1000,
	useCachedGroupMetadata: false,
	enableCallHistory: false,
	reconnectOnNetworkChange: false
}
exports.MEDIA_PATH_MAP = {
	image: '/mms/image',
	video: '/mms/video',
	document: '/mms/document',
	audio: '/mms/audio',
	sticker: '/mms/image',
	'thumbnail-link': '/mms/image',
	'thumbnail-image': '/mms/image',
	'thumbnail-video': '/mms/video',
	'thumbnail-document': '/mms/document',
	'product-catalog-image': '/product/image',
	'md-app-state': '',
	'md-msg-hist': '/mms/md-app-state',
	'biz-cover-photo': '/pps/biz-cover-photo',
	ptv: '/mms/video'
}
exports.MEDIA_HKDF_KEY_MAPPING = {
	audio: 'Audio',
	document: 'Document',
	gif: 'Video',
	image: 'Image',
	ppic: '',
	product: 'Image',
	ptt: 'Audio',
	sticker: 'Image',
	video: 'Video',
	'thumbnail-document': 'Document Thumbnail',
	'thumbnail-image': 'Image Thumbnail',
	'thumbnail-video': 'Video Thumbnail',
	'thumbnail-link': 'Link Thumbnail',
	'md-msg-hist': 'History',
	'md-app-state': 'App State',
	'product-catalog-image': 'Product Catalog Image',
	'payment-bg-image': 'Payment Background',
	ptv: 'Video',
	'biz-cover-photo': 'Image',
	location: 'Location',
	contact: 'Contact',
	'voip-token': 'Voip Token'
}
exports.MEDIA_KEYS = Object.keys(exports.MEDIA_PATH_MAP)
exports.MIN_PREKEY_COUNT = 5
exports.INITIAL_PREKEY_COUNT = 812
exports.UPLOAD_TIMEOUT = 30000 // 30 seconds
exports.MIN_UPLOAD_INTERVAL = 5000 // 5 seconds minimum between uploads
exports.DEFAULT_CACHE_TTLS = {
	SIGNAL_STORE: 5 * 60, // 5 minutes
	MSG_RETRY: 60 * 60, // 1 hour
	CALL_OFFER: 5 * 60, // 5 minutes
	USER_DEVICES: 5 * 60, // 5 minutes
	GROUP_METADATA: 30 * 60, // 30 minutes
	CALL_SESSION: 10 * 60, // 10 minutes
	USYNC_RESULTS: 10 * 60, // 10 minutes
	IDENTITY_PROOF: 60 * 60 // 1 hour
}
exports.TimeMs = {
	Second: 1000,
	Minute: 60 * 1000,
	Hour: 60 * 60 * 1000,
	Day: 24 * 60 * 60 * 1000,
	Week: 7 * 24 * 60 * 60 * 1000,
	Month: 30 * 24 * 60 * 60 * 1000
}
