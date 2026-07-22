'use strict'
var __importDefault =
	(this && this.__importDefault) ||
	function (mod) {
		return mod && mod.__esModule ? mod : { default: mod }
	}
Object.defineProperty(exports, '__esModule', { value: true })
exports.makeChatsSocket = void 0
const node_cache_1 = __importDefault(require('@cacheable/node-cache'))
const boom_1 = require('@hapi/boom')
const index_js_1 = require('../../WAProto/index.js')
const Defaults_1 = require('../Defaults')
const Types_1 = require('../Types')
const State_1 = require('../Types/State')
const Utils_1 = require('../Utils')
const make_mutex_1 = require('../Utils/make-mutex')
const process_message_1 = __importDefault(require('../Utils/process-message'))
const tc_token_utils_1 = require('../Utils/tc-token-utils')
const WABinary_1 = require('../WABinary')
const WAUSync_1 = require('../WAUSync')
const socket_js_1 = require('./socket.js')
const interop_js_1 = require('./interop.js')
const makeChatsSocket = config => {
	const {
		logger,
		markOnlineOnConnect,
		fireInitQueries,
		appStateMacVerification,
		shouldIgnoreJid,
		shouldSyncHistoryMessage,
		getMessage
	} = config
	const sock = (0, interop_js_1.makeInteropSocket)((0, socket_js_1.makeSocket)(config))
	const {
		ev,
		ws,
		authState,
		generateMessageTag,
		sendNode,
		query,
		signalRepository,
		onUnexpectedError,
		sendUnifiedSession,
		initInterop,
		fetchIntegrators,
		acceptInteropTOS,
		optInIntegrators,
		optOutIntegrators,
		resolveInteropUser,
		resolveInteropUsers,
		getReachabilitySettings,
		setReachabilitySettings,
		blockInteropUser,
		unblockInteropUser,
		reportInteropSpam,
		trustInteropContact,
		createInteropGroup,
		leaveInteropGroup,
		getInteropGroupAddPrivacy,
		INTEGRATOR_BIRDYCHAT,
		INTEGRATOR_HAIKET
	} = sock
	const getLIDForPN = signalRepository.lidMapping.getLIDForPN.bind(signalRepository.lidMapping)
	let privacySettings
	/** Server-assigned AB props for protocol behavior. */
	const serverProps = {
		/** AB prop 10518: gate tctoken on 1:1 messages. Default true (safe: avoids 463). */
		privacyTokenOn1to1: true,
		/** AB prop 9666: gate tctoken on profile picture IQs. WA Web default: true. */
		profilePicPrivacyToken: true,
		/** AB prop 14303: issue tctokens to LID instead of PN. WA Web default: false. */
		lidTrustedTokenIssueToLid: false
	}
	let syncState = State_1.SyncState.Connecting
	/** this mutex ensures that messages are processed in order */
	const messageMutex = (0, make_mutex_1.makeMutex)()
	/** this mutex ensures that receipts are processed in order */
	const receiptMutex = (0, make_mutex_1.makeMutex)()
	/** this mutex ensures that app state patches are processed in order */
	const appStatePatchMutex = (0, make_mutex_1.makeMutex)()
	/** this mutex ensures that notifications are processed in order */
	const notificationMutex = (0, make_mutex_1.makeMutex)()
	// Timeout for AwaitingInitialSync state
	let awaitingSyncTimeout
	// In-memory history sync completion tracking (resets on reconnection)
	const historySyncStatus = {
		initialBootstrapComplete: false,
		recentSyncComplete: false
	}
	let historySyncPausedTimeout
	// Collections blocked on missing app state sync keys (mirrors WA Web's "Blocked" state).
	// When a key arrives via APP_STATE_SYNC_KEY_SHARE, these are re-synced.
	const blockedCollections = new Set()
	/** messageId → numeric server_id for newsletter messages (persists within session) */
	const _nlServerIdCache = new Map()
	const placeholderResendCache =
		config.placeholderResendCache ||
		new node_cache_1.default({
			stdTTL: Defaults_1.DEFAULT_CACHE_TTLS.MSG_RETRY, // 1 hour
			useClones: false
		})
	if (!config.placeholderResendCache) {
		config.placeholderResendCache = placeholderResendCache
	}
	/** helper function to fetch the given app state sync key */
	const getAppStateSyncKey = async keyId => {
		const { [keyId]: key } = await authState.keys.get('app-state-sync-key', [keyId])
		return key
	}
	const fetchPrivacySettings = async (force = false) => {
		if (!privacySettings || force) {
			const { content } = await query({
				tag: 'iq',
				attrs: {
					xmlns: 'privacy',
					to: WABinary_1.S_WHATSAPP_NET,
					type: 'get'
				},
				content: [{ tag: 'privacy', attrs: {} }]
			})
			const privacyNode = content?.[0]
			privacySettings = (0, WABinary_1.reduceBinaryNodeToDictionary)(privacyNode, 'category')

			// A. Online Privacy Mode — may arrive as <category name="online" value="..."/> or
			//    as a dedicated <online_privacy_setting value="..."/> child node.
			const onlinePrivacy =
				privacySettings['online'] ||
				(0, WABinary_1.getBinaryNodeChild)(privacyNode, 'online_privacy_setting')?.attrs?.value ||
				'all'

			// C. Enhanced Block — root attrs or dedicated child node.
			const enhancedBlockEnabled =
				privacyNode?.attrs?.enhanced_block_enabled === 'true' ||
				(0, WABinary_1.getBinaryNodeChild)(privacyNode, 'enhanced_block')?.attrs?.enabled === 'true'

			// E. MD Privacy V2 flag.
			const mdPrivacyV2 =
				privacyNode?.attrs?.md_privacy_v2 === 'true' ||
				(0, WABinary_1.getBinaryNodeChild)(privacyNode, 'md_privacy_v2')?.attrs?.value === 'true'

			// F. Syncd clear-chat / delete-chat flag.
			const syncdClearChatDeleteChatEnabled =
				privacyNode?.attrs?.syncd_clear_chat_delete_chat_enabled === 'true' ||
				(0, WABinary_1.getBinaryNodeChild)(privacyNode, 'syncd_clear_chat')?.attrs?.delete_chat_enabled === 'true'

			// A. Syncd anti-tampering fatal-exception gate.
			const syncdAntiTamperingEnabled =
				privacyNode?.attrs?.syncd_anti_tampering_fatal_exception_enabled === 'true' ||
				(0, WABinary_1.getBinaryNodeChild)(privacyNode, 'syncd_anti_tampering')?.attrs?.fatal_exception_enabled ===
					'true'

			// B. Syncd key-index rotation gate.
			const keyRotationEnabled =
				privacyNode?.attrs?.syncd_key_rotation_enabled === 'true' ||
				(0, WABinary_1.getBinaryNodeChild)(privacyNode, 'syncd_key_rotation')?.attrs?.enabled === 'true'

			// Emit combined settings update so consumers can react without parsing raw creds.
			ev.emit('settings.update', {
				onlinePrivacy,
				enhancedBlockEnabled,
				mdPrivacyV2,
				syncdClearChatDeleteChatEnabled,
				...(syncdAntiTamperingEnabled ? { syncdAntiTamperingEnabled: true } : {}),
				keyRotationEnabled
			})

			// Persist extended privacy flags in credentials.
			ev.emit('creds.update', {
				privacySettings: {
					onlinePrivacy,
					enhancedBlockEnabled,
					mdPrivacyV2,
					syncdClearChatDeleteChatEnabled,
					syncdAntiTamperingEnabled,
					keyRotationEnabled
				}
			})
		}
		return privacySettings
	}
	/** helper function to run a privacy IQ query */
	const privacyQuery = async (name, value) => {
		await query({
			tag: 'iq',
			attrs: {
				xmlns: 'privacy',
				to: WABinary_1.S_WHATSAPP_NET,
				type: 'set'
			},
			content: [
				{
					tag: 'privacy',
					attrs: {},
					content: [
						{
							tag: 'category',
							attrs: { name, value }
						}
					]
				}
			]
		})
	}
	const updateMessagesPrivacy = async value => {
		await privacyQuery('messages', value)
	}
	const updateCallPrivacy = async value => {
		await privacyQuery('calladd', value)
	}
	const updateLastSeenPrivacy = async value => {
		await privacyQuery('last', value)
	}
	const updateOnlinePrivacy = async value => {
		await privacyQuery('online', value)
	}
	const updateProfilePicturePrivacy = async value => {
		await privacyQuery('profile', value)
	}
	const updateStatusPrivacy = async value => {
		await privacyQuery('status', value)
	}
	/**
	 * Fetch status privacy settings via `xmlns="status"` IQ GET.
	 * Returns the current distribution type and any custom lists.
	 * Source: GetStatusPrivacyJob.java, feature flag 3843 controls retry.
	 */
	const getStatusPrivacy = async () => {
		const result = await query({
			tag: 'iq',
			attrs: {
				xmlns: 'status',
				to: WABinary_1.S_WHATSAPP_NET,
				type: 'get'
			},
			content: [{ tag: 'privacy', attrs: {} }]
		})
		const privacyNode = result?.content?.[0]
		if (!privacyNode) return null
		const lists = []
		for (const listNode of privacyNode.content || []) {
			const { type, id, listname, emoji, selected, deleted } = listNode.attrs || {}
			const members = (listNode.content || []).map(u => u.attrs?.jid).filter(Boolean)
			lists.push({ type, id, listname, emoji, selected: selected === 'true', deleted: deleted === 'true', members })
		}
		return lists
	}
	/**
	 * Set status privacy via `xmlns="status"` IQ SET.
	 * Supports simple distribution types and contact-level whitelist/blacklist/customlist.
	 *
	 * @param {'contacts'|'whitelist'|'blacklist'|'null'} type - Distribution type
	 * @param {string[]} [jids] - JIDs for the list (whitelist/blacklist)
	 * @param {Array<{id: string, listname: string, emoji?: string, selected?: boolean, deleted?: boolean, members?: string[]}>} [customLists]
	 */
	const setStatusPrivacy = async (type, jids = [], customLists = []) => {
		const content = []
		// main distribution list
		const mainList = {
			tag: 'list',
			attrs: { type },
			content: jids.map(jid => ({ tag: 'user', attrs: { jid }, content: [] }))
		}
		content.push(mainList)
		// custom named lists
		for (const cl of customLists) {
			const attrs = { type: 'customlist', id: cl.id, listname: cl.listname }
			if (cl.emoji) attrs.emoji = cl.emoji
			if (cl.selected) attrs.selected = 'true'
			if (cl.deleted) attrs.deleted = 'true'
			content.push({
				tag: 'list',
				attrs,
				content: (cl.members || []).map(jid => ({ tag: 'user', attrs: { jid }, content: [] }))
			})
		}
		await query({
			tag: 'iq',
			attrs: {
				xmlns: 'status',
				to: WABinary_1.S_WHATSAPP_NET,
				type: 'set'
			},
			content: [{ tag: 'privacy', attrs: {}, content }]
		})
	}
	const updateReadReceiptsPrivacy = async value => {
		await privacyQuery('readreceipts', value)
	}
	const updateGroupsAddPrivacy = async value => {
		await privacyQuery('groupadd', value)
	}
	const updateDefaultDisappearingMode = async duration => {
		await query({
			tag: 'iq',
			attrs: {
				xmlns: 'disappearing_mode',
				to: WABinary_1.S_WHATSAPP_NET,
				type: 'set'
			},
			content: [
				{
					tag: 'disappearing_mode',
					attrs: {
						duration: duration.toString()
					}
				}
			]
		})
	}
	/**
	 * Fetch broadcast list quota from the server.
	 * Source: BroadcastListQuotaProtocol.java — IQ xmlns="w:biz", 32s timeout.
	 *
	 * Returns: { messagesLeft, totalLimit, isHeavySender, startTs, endTs, resetTs }
	 */
	const fetchBroadcastListQuota = async () => {
		const result = await query(
			{
				tag: 'iq',
				attrs: {
					xmlns: 'w:biz',
					to: WABinary_1.S_WHATSAPP_NET,
					type: 'get'
				},
				content: [{ tag: 'broadcast_list_quota', attrs: {}, content: [] }]
			},
			32000
		)
		const limitsNode = (0, WABinary_1.getBinaryNodeChild)(result, 'limits')
		const timeframeNode = (0, WABinary_1.getBinaryNodeChild)(result, 'timeframe')
		if (!limitsNode) return null
		return {
			messagesLeft: parseInt(
				limitsNode.attrs?.messages_left ??
					(0, WABinary_1.getBinaryNodeChild)(limitsNode, 'messages_left')?.content ??
					'0',
				10
			),
			totalLimit: parseInt(
				limitsNode.attrs?.total_limit ?? (0, WABinary_1.getBinaryNodeChild)(limitsNode, 'total_limit')?.content ?? '0',
				10
			),
			isHeavySender:
				(limitsNode.attrs?.is_heavy_sender ??
					(0, WABinary_1.getBinaryNodeChild)(limitsNode, 'is_heavy_sender')?.content) === 'true',
			startTs: parseInt(
				timeframeNode?.attrs?.start_ts_s ??
					(0, WABinary_1.getBinaryNodeChild)(timeframeNode, 'start_ts_s')?.content ??
					'0',
				10
			),
			endTs: parseInt(
				timeframeNode?.attrs?.end_ts_s ?? (0, WABinary_1.getBinaryNodeChild)(timeframeNode, 'end_ts_s')?.content ?? '0',
				10
			),
			resetTs: parseInt(
				timeframeNode?.attrs?.reset_ts_s ??
					(0, WABinary_1.getBinaryNodeChild)(timeframeNode, 'reset_ts_s')?.content ??
					'0',
				10
			)
		}
	}

	const getBotListV2 = async () => {
		const resp = await query({
			tag: 'iq',
			attrs: {
				xmlns: 'bot',
				to: WABinary_1.S_WHATSAPP_NET,
				type: 'get'
			},
			content: [
				{
					tag: 'bot',
					attrs: {
						v: '2'
					}
				}
			]
		})
		const botNode = (0, WABinary_1.getBinaryNodeChild)(resp, 'bot')
		const botList = []
		for (const section of (0, WABinary_1.getBinaryNodeChildren)(botNode, 'section')) {
			if (section.attrs.type === 'all') {
				for (const bot of (0, WABinary_1.getBinaryNodeChildren)(section, 'bot')) {
					botList.push({
						jid: bot.attrs.jid,
						personaId: bot.attrs['persona_id']
					})
				}
			}
		}
		return botList
	}
	/**
	 * Get the global chat-blocking status (block messages from unknown accounts).
	 * Ported from WhatsApp Web's WASmaxPsaChatBlockGetRPC (xmlns `w:comms:chat`).
	 * @returns {Promise<'blocked' | 'unblocked' | undefined>}
	 */
	const getChatBlockingStatus = async () => {
		const result = await query({
			tag: 'iq',
			attrs: {
				to: WABinary_1.S_WHATSAPP_NET,
				xmlns: 'w:comms:chat',
				type: 'get'
			},
			content: [{ tag: 'query', attrs: {}, content: [{ tag: 'blocking_status', attrs: {} }] }]
		})
		const blocking =
			(0, WABinary_1.getBinaryNodeChild)(result, 'blocking') ||
			(0, WABinary_1.getBinaryNodeChild)((0, WABinary_1.getBinaryNodeChild)(result, 'query'), 'blocking')
		return blocking?.attrs?.status
	}
	/**
	 * Set the global chat-blocking status (block messages from unknown accounts).
	 * Ported from WhatsApp Web's WASmaxPsaChatBlockSetRPC (xmlns `w:comms:chat`).
	 * @param {'block' | 'unblock'} action
	 * @returns {Promise<'blocked' | 'unblocked' | undefined>} the resulting status
	 */
	const updateChatBlockingStatus = async action => {
		const result = await query({
			tag: 'iq',
			attrs: {
				to: WABinary_1.S_WHATSAPP_NET,
				xmlns: 'w:comms:chat',
				type: 'set'
			},
			content: [{ tag: 'blocking', attrs: { action } }]
		})
		const blocking = (0, WABinary_1.getBinaryNodeChild)(result, 'blocking')
		return blocking?.attrs?.status
	}
	/**
	 * Get the user's pending TOS disclosures / notices.
	 * Ported from WhatsApp Web's WASmaxUserNoticeGetDisclosuresRPC (xmlns `tos`).
	 * @param {number} [t] last-seen disclosure timestamp
	 * @returns {Promise<Array<Record<string, string>>>} the `<notice>` attributes
	 */
	const getUserDisclosures = async (t = 0) => {
		const result = await query({
			tag: 'iq',
			attrs: { to: WABinary_1.S_WHATSAPP_NET, xmlns: 'tos', type: 'get' },
			content: [{ tag: 'get_user_disclosures', attrs: { t: String(t) } }]
		})
		return (0, WABinary_1.getBinaryNodeChildren)(result, 'notice').map(n => ({ ...n.attrs }))
	}
	/**
	 * Accept a TOS/disclosure notice (`xmlns="tos"` set with `<trackable>`).
	 * Mirrors WASmaxUserNoticeTrackDisclosureRPC from WA Web.
	 * @param {string} noticeId the notice id (e.g. "20250211")
	 * @param {string|number} result the result code (e.g. "105")
	 */
	const acceptTosNotice = async (noticeId, result = '105') => {
		await query({
			tag: 'iq',
			attrs: { to: WABinary_1.S_WHATSAPP_NET, xmlns: 'tos', type: 'set' },
			content: [{ tag: 'trackable', attrs: { id: String(noticeId), result: String(result) } }]
		})
	}
	/**
	 * Report spam for a chat/group with sample messages.
	 * Mirrors WASmaxReportSpamRPC (xmlns="spam", type="set").
	 * @param {string} jid the JID of the chat or group being reported
	 * @param {Array<{id:string, from:string, t:number}>} messages up to ~5 recent messages as evidence
	 * @param {string} [spamFlow] e.g. "group_info_report" or "contact_info_report"
	 * @param {string} [subject] human-readable subject string (group name or contact name)
	 */
	const reportSpam = async (jid, messages, spamFlow = 'contact_info_report', subject) => {
		const msgNodes = (messages || []).map(m => ({
			tag: 'message',
			attrs: {
				from: String(jid),
				t: String(m.t),
				id: String(m.id)
			}
		}))
		await query({
			tag: 'iq',
			attrs: { to: WABinary_1.S_WHATSAPP_NET, xmlns: 'spam', type: 'set' },
			content: [
				{
					tag: 'spam_list',
					attrs: {
						jid: String(jid),
						spam_flow: String(spamFlow),
						...(subject ? { subject: String(subject) } : {})
					},
					content: msgNodes
				}
			]
		})
	}
	/**
	 * Get the account opt-out list (`optoutlist` IQ). Returns the raw result node.
	 */
	const getOptOutList = async () => {
		return query({
			tag: 'iq',
			attrs: { to: WABinary_1.S_WHATSAPP_NET, xmlns: 'optoutlist', type: 'get' }
		})
	}
	/**
	 * Sign a blinded credential for privacy-preserving anonymous stats.
	 * Mirrors WASmaxPrivateStatsSignCredentialRPC (xmlns `privatestats`).
	 * @param {Buffer} blindedCredential 32-byte blinded credential
	 * @returns {Promise<Buffer|undefined>} signed credential bytes from server
	 */
	const signPrivateCredential = async blindedCredential => {
		const result = await query({
			tag: 'iq',
			attrs: { to: WABinary_1.S_WHATSAPP_NET, xmlns: 'privatestats', type: 'get' },
			content: [
				{
					tag: 'sign_credential',
					attrs: { version: '1' },
					content: [{ tag: 'blinded_credential', attrs: {}, content: blindedCredential }]
				}
			]
		})
		const signedNode = (0, WABinary_1.getBinaryNodeChild)(result, 'sign_credential')
		const signedBytes = (0, WABinary_1.getBinaryNodeChild)(signedNode, 'signed_credential')
		return signedBytes?.content instanceof Uint8Array ? Buffer.from(signedBytes.content) : undefined
	}
	/**
	 * Get push-notification settings (`urn:xmpp:whatsapp:push`).
	 */
	const getPushConfig = async () => {
		const result = await query({
			tag: 'iq',
			attrs: { to: WABinary_1.S_WHATSAPP_NET, xmlns: 'urn:xmpp:whatsapp:push', type: 'get' },
			content: [{ tag: 'settings', attrs: {} }]
		})
		return (0, WABinary_1.getBinaryNodeChild)(result, 'settings')
	}
	/**
	 * Set push-notification config (`urn:xmpp:whatsapp:push`). Mainly web push —
	 * pass the FCM-style config (platform / endpoint / auth / p256dh).
	 * @param {Record<string, string>} config
	 */
	const setPushConfig = async config => {
		await query({
			tag: 'iq',
			attrs: { to: WABinary_1.S_WHATSAPP_NET, xmlns: 'urn:xmpp:whatsapp:push', type: 'set' },
			content: [{ tag: 'config', attrs: config }]
		})
	}
	const fetchStatus = async (...jids) => {
		const usyncQuery = new WAUSync_1.USyncQuery().withStatusProtocol()
		for (const jid of jids) {
			usyncQuery.withUser(new WAUSync_1.USyncUser().withId(jid))
		}
		const result = await executeUSyncQuery(usyncQuery)
		if (result) {
			return result.list
		}
	}
	const fetchDisappearingDuration = async (...jids) => {
		const usyncQuery = new WAUSync_1.USyncQuery().withDisappearingModeProtocol()
		for (const jid of jids) {
			usyncQuery.withUser(new WAUSync_1.USyncUser().withId(jid))
		}
		const result = await executeUSyncQuery(usyncQuery)
		if (result) {
			return result.list
		}
	}
	/** update the profile picture for yourself or a group */
	const updateProfilePicture = async (jid, content, dimensions) => {
		let targetJid
		if (!jid) {
			throw new boom_1.Boom(
				'Illegal no-jid profile update. Please specify either your ID or the ID of the chat you wish to update'
			)
		}
		if ((0, WABinary_1.jidNormalizedUser)(jid) !== (0, WABinary_1.jidNormalizedUser)(authState.creds.me.id)) {
			targetJid = (0, WABinary_1.jidNormalizedUser)(jid) // in case it is someone other than us
		} else {
			targetJid = undefined
		}
		const { img } = await (0, Utils_1.generateProfilePicture)(content, dimensions)
		await query({
			tag: 'iq',
			attrs: {
				to: WABinary_1.S_WHATSAPP_NET,
				type: 'set',
				xmlns: 'w:profile:picture',
				...(targetJid ? { target: targetJid } : {})
			},
			content: [
				{
					tag: 'picture',
					attrs: { type: 'image' },
					content: img
				}
			]
		})
	}
	/** remove the profile picture for yourself or a group */
	const removeProfilePicture = async jid => {
		let targetJid
		if (!jid) {
			throw new boom_1.Boom(
				'Illegal no-jid profile update. Please specify either your ID or the ID of the chat you wish to update'
			)
		}
		if ((0, WABinary_1.jidNormalizedUser)(jid) !== (0, WABinary_1.jidNormalizedUser)(authState.creds.me.id)) {
			targetJid = (0, WABinary_1.jidNormalizedUser)(jid) // in case it is someone other than us
		} else {
			targetJid = undefined
		}
		await query({
			tag: 'iq',
			attrs: {
				to: WABinary_1.S_WHATSAPP_NET,
				type: 'set',
				xmlns: 'w:profile:picture',
				...(targetJid ? { target: targetJid } : {})
			}
		})
	}
	/** update the profile status for yourself */
	const updateProfileStatus = async status => {
		await query({
			tag: 'iq',
			attrs: {
				to: WABinary_1.S_WHATSAPP_NET,
				type: 'set',
				xmlns: 'status'
			},
			content: [
				{
					tag: 'status',
					attrs: {},
					content: Buffer.from(status, 'utf-8')
				}
			]
		})
	}
	const updateProfileName = async name => {
		await chatModify({ pushNameSetting: name }, '')
	}
	// dhash: previously-seen blocklist delta-hash, for incremental sync — server returns
	// the current dhash unconditionally, and a fresh list only when it doesn't match.
	// Confirmed from live capture: content is null for a full fetch, or a single
	// <item dhash="..."/> child for the incremental check — never a <blocklist/> child.
	const fetchBlocklist = async (dhash = null) => {
		const result = await query({
			tag: 'iq',
			attrs: {
				xmlns: 'blocklist',
				to: WABinary_1.S_WHATSAPP_NET,
				type: 'get'
			},
			content: dhash ? [{ tag: 'item', attrs: { dhash } }] : null
		})
		const listNode = (0, WABinary_1.getBinaryNodeChild)(result, 'list')
		const jids = (0, WABinary_1.getBinaryNodeChildren)(listNode, 'item').map(n => n.attrs.jid)
		ev.emit('blocklist.set', { blocklist: jids })
		return jids
	}
	const updateBlockStatus = async (jid, action) => {
		await query({
			tag: 'iq',
			attrs: {
				xmlns: 'blocklist',
				to: WABinary_1.S_WHATSAPP_NET,
				type: 'set'
			},
			content: [
				{
					tag: 'item',
					attrs: {
						action,
						jid
					}
				}
			]
		})
	}
	const getBusinessProfile = async jid => {
		// Confirmed from live capture: business_profile uses v="116" (not "244"), and
		// verified_name is always its own separate w:biz iq — { jid } attr, no xmlns
		// child attr — never bundled into the business_profile request.
		const [results, verifiedNameResult] = await Promise.all([
			query({
				tag: 'iq',
				attrs: {
					to: 's.whatsapp.net',
					xmlns: 'w:biz',
					type: 'get'
				},
				content: [
					{
						tag: 'business_profile',
						attrs: { v: '116' },
						content: [
							{
								tag: 'profile',
								attrs: { jid }
							}
						]
					}
				]
			}),
			query({
				tag: 'iq',
				attrs: {
					to: 's.whatsapp.net',
					xmlns: 'w:biz',
					type: 'get'
				},
				content: [
					{
						tag: 'verified_name',
						attrs: { jid }
					}
				]
			})
		])
		// Parse verified_name certificate if present in the response
		const verifiedNameNode = (0, WABinary_1.getBinaryNodeChild)(verifiedNameResult, 'verified_name')
		let verifiedNameCert
		if (verifiedNameNode) {
			const certNode = (0, WABinary_1.getBinaryNodeChild)(verifiedNameNode, 'certificate')
			if (certNode) {
				const detailsNode = (0, WABinary_1.getBinaryNodeChild)(certNode, 'details')
				const localizedNames = (0, WABinary_1.getBinaryNodeChildren)(certNode, 'localized_name').map(n => ({
					lg: n.attrs?.lg,
					lc: n.attrs?.lc,
					verifiedName: n.attrs?.verified_name || n.content?.toString()
				}))
				verifiedNameCert = {
					certSerial: certNode.attrs?.serial ? +certNode.attrs.serial : undefined,
					issuer: certNode.attrs?.issuer,
					details: {
						verifiedName: detailsNode?.attrs?.verified_name || detailsNode?.content?.toString(),
						localizedNames
					}
				}
			}
		}
		const profileNode = (0, WABinary_1.getBinaryNodeChild)(results, 'business_profile')
		const profiles = (0, WABinary_1.getBinaryNodeChild)(profileNode, 'profile')
		if (profiles) {
			const address = (0, WABinary_1.getBinaryNodeChild)(profiles, 'address')
			const description = (0, WABinary_1.getBinaryNodeChild)(profiles, 'description')
			const website = (0, WABinary_1.getBinaryNodeChild)(profiles, 'website')
			const email = (0, WABinary_1.getBinaryNodeChild)(profiles, 'email')
			const category = (0, WABinary_1.getBinaryNodeChild)(
				(0, WABinary_1.getBinaryNodeChild)(profiles, 'categories'),
				'category'
			)
			const businessHours = (0, WABinary_1.getBinaryNodeChild)(profiles, 'business_hours')
			const businessHoursConfig = businessHours
				? (0, WABinary_1.getBinaryNodeChildren)(businessHours, 'business_hours_config')
				: undefined
			const websiteStr = website?.content?.toString()

			// Catalog status from profile attrs
			const catalogStatus = {
				exists: profiles.attrs?.catalog_exists === 'true' || profiles.attrs?.catalog_exists === true || false,
				sendAll: profiles.attrs?.catalog_send_all === 'true' || profiles.attrs?.catalog_send_all === true || false
			}

			// Cart flags from profile attrs
			const cartEnabled =
				profiles.attrs?.cart_enabled !== undefined
					? profiles.attrs.cart_enabled === 'true' || profiles.attrs.cart_enabled === true
					: undefined
			const webCartEnabled =
				profiles.attrs?.web_cart_enabled !== undefined
					? profiles.attrs.web_cart_enabled === 'true' || profiles.attrs.web_cart_enabled === true
					: undefined
			const webCartOnOff = profiles.attrs?.web_cart_on_off

			// Commerce experience from profile attrs
			const commerceExperience = profiles.attrs?.commerce_experience

			return {
				wid: profiles.attrs?.jid,
				address: address?.content?.toString(),
				businessAddress: address?.content?.toString(),
				description: description?.content?.toString() || '',
				website: websiteStr ? [websiteStr] : [],
				email: email?.content?.toString(),
				category: category?.content?.toString(),
				business_hours: {
					timezone: businessHours?.attrs?.timezone,
					business_config: businessHoursConfig?.map(({ attrs }) => attrs)
				},
				businessHours: businessHoursConfig
					? {
							timezone: businessHours?.attrs?.timezone ?? null,
							config: businessHoursConfig.map(({ attrs }) => ({
								dayOfWeek: attrs?.day_of_week ?? null,
								openTime: attrs?.open_time ?? null,
								closeTime: attrs?.close_time ?? null,
								mode: attrs?.mode ?? null
							}))
						}
					: null,
				catalogStatus,
				cartEnabled,
				webCartEnabled,
				webCartOnOff,
				commerceExperience,
				verifiedNameCert
			}
		}
	}
	const cleanDirtyBits = async (type, fromTimestamp) => {
		logger.info({ fromTimestamp }, 'clean dirty bits ' + type)
		await sendNode({
			tag: 'iq',
			attrs: {
				to: WABinary_1.S_WHATSAPP_NET,
				type: 'set',
				xmlns: 'urn:xmpp:whatsapp:dirty',
				id: generateMessageTag()
			},
			content: [
				{
					tag: 'clean',
					attrs: {
						type,
						...(fromTimestamp ? { timestamp: fromTimestamp.toString() } : null)
					}
				}
			]
		})
	}
	const newAppStateChunkHandler = isInitialSync => {
		return {
			onMutation(mutation) {
				;(0, Utils_1.processSyncAction)(
					mutation,
					ev,
					authState.creds.me,
					isInitialSync ? { accountSettings: authState.creds.accountSettings } : undefined,
					logger
				)
				// Persist NCT salt received via App-State-Sync (SyncActionValue field 80)
				const _nctSalt = mutation?.syncAction?.value?.nctSaltSyncAction?.salt
				if (_nctSalt?.length) {
					authState.keys
						.set({ 'nct-salt': { default: Buffer.from(_nctSalt) } })
						.catch(err => logger.debug({ err: err?.message }, 'nct: failed to persist salt'))
				}
			}
		}
	}
	const resyncAppState = ev.createBufferedFunction(async (collections, isInitialSync) => {
		const appStateSyncKeyCache = new Map()
		const getCachedAppStateSyncKey = async keyId => {
			if (appStateSyncKeyCache.has(keyId)) {
				return appStateSyncKeyCache.get(keyId)
			}
			const key = await getAppStateSyncKey(keyId)
			appStateSyncKeyCache.set(keyId, key ?? null)
			return key
		}
		// we use this to determine which events to fire
		// otherwise when we resync from scratch -- all notifications will fire
		const initialVersionMap = {}
		const globalMutationMap = {}
		await authState.keys.transaction(async () => {
			const collectionsToHandle = new Set(collections)
			// in case something goes wrong -- ensure we don't enter a loop that cannot be exited from
			const attemptsMap = {}
			const forceSnapshotCollections = new Set()
			// keep executing till all collections are done
			// sometimes a single patch request will not return all the patches (God knows why)
			// so we fetch till they're all done (this is determined by the "has_more_patches" flag)
			while (collectionsToHandle.size) {
				const states = {}
				const nodes = []
				for (const name of collectionsToHandle) {
					const result = await authState.keys.get('app-state-sync-version', [name])
					let state = result[name]
					if (state) {
						if (initialVersionMap[name] === undefined) {
							initialVersionMap[name] = state.version
						}
					} else {
						state = (0, Utils_1.newLTHashState)()
					}
					states[name] = state
					const shouldForceSnapshot = forceSnapshotCollections.has(name)
					if (shouldForceSnapshot) {
						forceSnapshotCollections.delete(name)
					}
					logger.info(`resyncing ${name} from v${state.version}${shouldForceSnapshot ? ' (forcing snapshot)' : ''}`)
					nodes.push({
						tag: 'collection',
						attrs: {
							name,
							version: state.version.toString(),
							// return snapshot if syncing from scratch or forcing after a failed attempt
							return_snapshot: (shouldForceSnapshot || !state.version).toString()
						}
					})
				}
				const result = await query({
					tag: 'iq',
					attrs: {
						to: WABinary_1.S_WHATSAPP_NET,
						xmlns: 'w:sync:app:state',
						type: 'set'
					},
					content: [
						{
							tag: 'sync',
							attrs: {},
							content: nodes
						}
					]
				})
				// extract from binary node
				const decoded = await (0, Utils_1.extractSyncdPatches)(result, config?.options)
				for (const key in decoded) {
					const name = key
					const { patches, hasMorePatches, snapshot } = decoded[name]
					try {
						if (snapshot) {
							const { state: newState, mutationMap } = await (0, Utils_1.decodeSyncdSnapshot)(
								name,
								snapshot,
								getCachedAppStateSyncKey,
								initialVersionMap[name],
								appStateMacVerification.snapshot
							)
							states[name] = newState
							Object.assign(globalMutationMap, mutationMap)
							logger.info(`restored state of ${name} from snapshot to v${newState.version} with mutations`)
							await authState.keys.set({ 'app-state-sync-version': { [name]: newState } })
						}
						// only process if there are syncd patches
						if (patches.length) {
							const { state: newState, mutationMap } = await (0, Utils_1.decodePatches)(
								name,
								patches,
								states[name],
								getCachedAppStateSyncKey,
								config.options,
								initialVersionMap[name],
								logger,
								appStateMacVerification.patch
							)
							await authState.keys.set({ 'app-state-sync-version': { [name]: newState } })
							logger.info(`synced ${name} to v${newState.version}`)
							initialVersionMap[name] = newState.version
							Object.assign(globalMutationMap, mutationMap)
						}
						if (hasMorePatches) {
							logger.info(`${name} has more patches...`)
						} else {
							// collection is done with sync
							collectionsToHandle.delete(name)
						}
					} catch (error) {
						attemptsMap[name] = (attemptsMap[name] || 0) + 1
						const logData = {
							name,
							attempt: attemptsMap[name],
							version: states[name].version,
							statusCode: error.output?.statusCode,
							errorType: error.name,
							error: error.stack
						}
						if ((0, Utils_1.isMissingKeyError)(error) && attemptsMap[name] >= Utils_1.MAX_SYNC_ATTEMPTS) {
							logger.warn(
								logData,
								`${name} blocked on missing key from v${states[name].version}, parking after ${attemptsMap[name]} attempts`
							)
							blockedCollections.add(name)
							collectionsToHandle.delete(name)
						} else if ((0, Utils_1.isMissingKeyError)(error)) {
							logger.info(
								logData,
								`${name} blocked on missing key from v${states[name].version}, retrying with snapshot`
							)
							forceSnapshotCollections.add(name)
						} else if ((0, Utils_1.isAppStateSyncIrrecoverable)(error, attemptsMap[name])) {
							logger.warn(logData, `failed to sync ${name} from v${states[name].version}, giving up`)
							collectionsToHandle.delete(name)
						} else {
							logger.info(logData, `failed to sync ${name} from v${states[name].version}, forcing snapshot retry`)
							forceSnapshotCollections.add(name)
						}
					}
				}
			}
		}, authState?.creds?.me?.id || 'resync-app-state')
		const { onMutation } = newAppStateChunkHandler(isInitialSync)
		for (const key in globalMutationMap) {
			onMutation(globalMutationMap[key])
		}
	})
	/**
	 * fetch the profile picture of a user/group
	 * type = "preview" for a low res picture
	 * type = "image"   for the high res picture URL (adds query="url")
	 * type = "avatar"  for the avatar variant (no query attr, confirmed from interop logs)
	 */
	const profilePictureUrl = async (jid, type = 'preview', timeoutMs) => {
		// Confirmed from live capture: query="url" is always present, for both
		// "preview" and "image" — not image-only as previously assumed.
		const picAttrs = { type, query: 'url' }
		const baseContent = [{ tag: 'picture', attrs: picAttrs }]
		// WA Web only includes tctoken for user JIDs (not groups/newsletters)
		// and never for own profile pic (Chat model for self has no tcToken).
		// Including tctoken for own JID causes the server to never respond.
		const normalizedJid = (0, WABinary_1.jidNormalizedUser)(jid)
		const isUserJid = (0, WABinary_1.isPnUser)(normalizedJid) || (0, WABinary_1.isLidUser)(normalizedJid)
		const me = authState.creds.me
		const isSelf =
			me &&
			(normalizedJid === (0, WABinary_1.jidNormalizedUser)(me.id) ||
				(me.lid && normalizedJid === (0, WABinary_1.jidNormalizedUser)(me.lid)))
		let content = baseContent
		if (serverProps.profilePicPrivacyToken && isUserJid && !isSelf) {
			content = await (0, tc_token_utils_1.buildTcTokenFromJid)({
				authState,
				jid: normalizedJid,
				baseContent,
				getLIDForPN
			})
		}
		jid = (0, WABinary_1.jidNormalizedUser)(jid)
		const result = await query(
			{
				tag: 'iq',
				attrs: {
					target: jid,
					to: WABinary_1.S_WHATSAPP_NET,
					type: 'get',
					xmlns: 'w:profile:picture'
				},
				content
			},
			timeoutMs
		)
		const child = (0, WABinary_1.getBinaryNodeChild)(result, 'picture')
		return child?.attrs?.url
	}
	const createCallLink = async (type, event, timeoutMs) => {
		const result = await query(
			{
				tag: 'call',
				attrs: {
					id: generateMessageTag(),
					to: '@call'
				},
				content: [
					{
						tag: 'link_create',
						attrs: { media: type },
						content: event ? [{ tag: 'event', attrs: { start_time: String(event.startTime) } }] : undefined
					}
				]
			},
			timeoutMs
		)
		const child = (0, WABinary_1.getBinaryNodeChild)(result, 'link_create')
		return child?.attrs?.token
	}
	/**
	 * Toggle the waiting room on an existing call link.
	 * Ported from WhatsApp Web's WASmaxVoipWaitingRoomToggleCallLinkRPC.
	 * @param {string} linkToken the call link token (from createCallLink)
	 * @param {boolean} enabled
	 * @param {'audio' | 'video'} [media]
	 */
	const toggleCallLinkWaitingRoom = async (linkToken, enabled, media = 'audio') => {
		const result = await query({
			tag: 'call',
			attrs: { id: generateMessageTag(), to: '@call' },
			content: [
				{
					tag: 'waiting_room_toggle',
					attrs: { enabled: enabled ? '1' : '0', 'link-token': linkToken, media }
				}
			]
		})
		const child = (0, WABinary_1.getBinaryNodeChild)(result, 'waiting_room_toggle')
		return child?.attrs
	}
	const sendPresenceUpdate = async (type, toJid) => {
		const me = authState.creds.me
		const isAvailableType = type === 'available'
		if (isAvailableType || type === 'unavailable') {
			if (!me.name) {
				logger.warn('no name present, ignoring presence update request...')
				return
			}
			ev.emit('connection.update', { isOnline: isAvailableType })
			if (isAvailableType) {
				void sendUnifiedSession()
			}
			await sendNode({
				tag: 'presence',
				attrs: {
					name: me.name.replace(/@/g, ''),
					type
				}
			})
		} else {
			const { server } = (0, WABinary_1.jidDecode)(toJid)
			const isLid = server === 'lid'
			await sendNode({
				tag: 'chatstate',
				attrs: {
					from: isLid ? me.lid : me.id,
					to: toJid
				},
				content: [
					{
						tag: type === 'recording' ? 'composing' : type,
						attrs: type === 'recording' ? { media: 'audio' } : {}
					}
				]
			})
		}
	}
	/**
	 * Store privacy tokens received from a usync response per-contact.
	 * Called externally when a USyncQuery result includes privacy_token data.
	 *
	 * @param {Array<{jid: string, privacyToken: Buffer, privacyModeTs: number|string}>} entries
	 */
	const storePrivacyTokens = async entries => {
		if (!entries?.length) return
		const write = {}
		for (const { jid, privacyToken, privacyModeTs } of entries) {
			if (!jid || !privacyToken?.length) continue
			write[jid] = {
				token: Buffer.isBuffer(privacyToken) ? privacyToken : Buffer.from(privacyToken),
				ts: String(privacyModeTs || '')
			}
		}
		if (Object.keys(write).length) {
			await authState.keys.set({ 'privacy-token': write })
		}
	}

	/**
	 * Wrapper around sock.executeUSyncQuery that automatically persists any per-contact
	 * privacy tokens (privacy_mode_ts + privacy_token) present in the usync result list,
	 * and emits contacts.update for any entries flagged isBlockedByContact.
	 *
	 * @param {import('../WAUSync/USyncQuery').USyncQuery} usyncQuery
	 */
	const executeUSyncQuery = async usyncQuery => {
		const result = await sock.executeUSyncQuery(usyncQuery)
		if (!result) return result

		// B. Auto-persist privacy tokens found in any usync response.
		const privacyEntries = []
		const blockedContacts = []
		for (const entry of [...(result.list || []), ...(result.sideList || [])]) {
			if (entry.privacy?.token) {
				privacyEntries.push({
					jid: entry.id,
					privacyToken: entry.privacy.token,
					privacyModeTs: entry.privacy.modeTs
				})
			}
			// G. Emit contacts.update for contacts that blocked us.
			if (entry.isBlockedByContact) {
				blockedContacts.push({ id: entry.id, isBlockedByContact: true })
			}
		}
		if (privacyEntries.length) {
			storePrivacyTokens(privacyEntries).catch(err => logger.warn({ err }, 'failed to store privacy tokens from usync'))
		}
		if (blockedContacts.length) {
			ev.emit('contacts.update', blockedContacts)
		}
		return result
	}

	/**
	 * @param toJid the jid to subscribe to
	 * @param options.presenceType optional presenceType attribute stored for the contact
	 * @param options.presenceName optional presenceName attribute for the subscribe stanza
	 * @param options.groupJid optional group JID — when set adds context="group" attribute
	 */
	const presenceSubscribe = async (toJid, { presenceType, presenceName, groupJid } = {}) => {
		// Only include tctoken for user JIDs — groups/newsletters don't use tctokens
		const normalizedToJid = (0, WABinary_1.jidNormalizedUser)(toJid)
		const isUserJid = (0, WABinary_1.isPnUser)(normalizedToJid) || (0, WABinary_1.isLidUser)(normalizedToJid)

		// Build presence attributes
		const presenceAttrs = {
			to: toJid,
			id: generateMessageTag(),
			type: 'subscribe'
		}

		// Accumulate child nodes for the presence stanza
		const presenceContent = []

		// A. TC Token as attribute: fetch stored token and attach as base64 tc_token attr
		if (isUserJid) {
			try {
				const storageJid = await (0, tc_token_utils_1.resolveTcTokenJid)(normalizedToJid, getLIDForPN)
				const tcTokenData = await authState.keys.get('tctoken', [storageJid])
				const entry = tcTokenData?.[storageJid]
				const tcTokenBuffer = entry?.token
				if (tcTokenBuffer?.length && !(0, tc_token_utils_1.isTcTokenExpired)(entry?.timestamp)) {
					presenceAttrs.tc_token = tcTokenBuffer.toString('base64')
				}
			} catch (e) {
				// best-effort — proceed without tc_token if lookup fails
			}

			// B. Privacy Token — include per-contact privacy token when available.
			// This token is issued by the contact's device via usync and gates presence
			// visibility when their online privacy is set to "contacts" or "contact_blacklist".
			try {
				const privTokenData = await authState.keys.get('privacy-token', [normalizedToJid])
				const privEntry = privTokenData?.[normalizedToJid]
				if (privEntry?.token?.length) {
					const privTokenAttrs = {}
					if (privEntry.ts) privTokenAttrs.t = privEntry.ts
					presenceContent.push({
						tag: 'privacy_token',
						attrs: privTokenAttrs,
						content: privEntry.token
					})
				}
			} catch (e) {
				// best-effort — proceed without privacy_token if lookup fails
			}
		}

		// C. presenceType and presenceName attributes
		if (presenceType) {
			presenceAttrs.presenceType = presenceType
		}
		if (presenceName) {
			presenceAttrs.presenceName = presenceName
		}

		// D. Group presence context
		if (groupJid) {
			presenceAttrs.context = 'group'
			presenceAttrs.group_jid = (0, WABinary_1.jidNormalizedUser)(groupJid)
		}

		return sendNode({
			tag: 'presence',
			attrs: presenceAttrs,
			content: presenceContent.length ? presenceContent : undefined
		})
	}
	const handlePresenceUpdate = ({ tag, attrs, content }) => {
		let presence
		const jid = attrs.from
		const participant = attrs.participant || attrs.from
		if (shouldIgnoreJid(jid) && jid !== WABinary_1.S_WHATSAPP_NET) {
			return
		}
		if (tag === 'presence') {
			presence = {
				lastKnownPresence: attrs.type === 'unavailable' ? 'unavailable' : 'available',
				lastSeen: attrs.last && attrs.last !== 'deny' ? +attrs.last : undefined
			}
		} else if (Array.isArray(content)) {
			const [firstChild] = content
			let type = firstChild.tag
			if (type === 'paused') {
				type = 'available'
			}
			if (firstChild.attrs?.media === 'audio') {
				type = 'recording'
			}
			presence = { lastKnownPresence: type }
		} else {
			logger.error({ tag, attrs, content }, 'recv invalid presence node')
		}
		if (presence) {
			ev.emit('presence.update', { id: jid, presences: { [participant]: presence } })
		}
	}
	const appPatch = async patchCreate => {
		const name = patchCreate.type
		const myAppStateKeyId = authState.creds.myAppStateKeyId
		if (!myAppStateKeyId) {
			throw new boom_1.Boom('App state key not present!', { statusCode: 400 })
		}
		let initial
		let encodeResult
		await appStatePatchMutex.mutex(async () => {
			await authState.keys.transaction(async () => {
				logger.debug({ patch: patchCreate }, 'applying app patch')
				await resyncAppState([name], false)
				const { [name]: currentSyncVersion } = await authState.keys.get('app-state-sync-version', [name])
				initial = currentSyncVersion || (0, Utils_1.newLTHashState)()
				encodeResult = await (0, Utils_1.encodeSyncdPatch)(patchCreate, myAppStateKeyId, initial, getAppStateSyncKey)
				const { patch, state } = encodeResult
				const node = {
					tag: 'iq',
					attrs: {
						to: WABinary_1.S_WHATSAPP_NET,
						type: 'set',
						xmlns: 'w:sync:app:state'
					},
					content: [
						{
							tag: 'sync',
							attrs: {},
							content: [
								{
									tag: 'collection',
									attrs: {
										name,
										version: (state.version - 1).toString(),
										return_snapshot: 'false'
									},
									content: [
										{
											tag: 'patch',
											attrs: {},
											content: index_js_1.proto.SyncdPatch.encode(patch).finish()
										}
									]
								}
							]
						}
					]
				}
				await query(node)
				await authState.keys.set({ 'app-state-sync-version': { [name]: state } })
			}, authState?.creds?.me?.id || 'app-patch')
		})
		if (config.emitOwnEvents) {
			const { onMutation } = newAppStateChunkHandler(false)
			const { mutationMap } = await (0, Utils_1.decodePatches)(
				name,
				[{ ...encodeResult.patch, version: { version: encodeResult.state.version } }],
				initial,
				getAppStateSyncKey,
				config.options,
				undefined,
				logger
			)
			for (const key in mutationMap) {
				onMutation(mutationMap[key])
			}
		}
	}
	/** sending non-abt props may fix QR scan fail if server expects */
	const fetchProps = async () => {
		//TODO: implement both protocol 1 and protocol 2 prop fetching, specially for abKey for WM
		const resultNode = await query({
			tag: 'iq',
			attrs: {
				to: WABinary_1.S_WHATSAPP_NET,
				xmlns: 'w',
				type: 'get'
			},
			content: [
				{
					tag: 'props',
					attrs: {
						protocol: '2',
						hash: authState?.creds?.lastPropHash || ''
					}
				}
			]
		})
		const propsNode = (0, WABinary_1.getBinaryNodeChild)(resultNode, 'props')
		let props = {}
		if (propsNode) {
			if (propsNode.attrs?.hash) {
				// on some clients, the hash is returning as undefined
				authState.creds.lastPropHash = propsNode?.attrs?.hash
				ev.emit('creds.update', authState.creds)
			}
			props = (0, WABinary_1.reduceBinaryNodeToDictionary)(propsNode, 'prop')
		}
		// Extract protocol-relevant AB props (only the ones we need)
		const privacyTokenProp = props['10518'] ?? props['privacy_token_sending_on_all_1_on_1_messages']
		if (privacyTokenProp !== undefined) {
			serverProps.privacyTokenOn1to1 = privacyTokenProp === 'true' || privacyTokenProp === '1'
		}
		const profilePicProp = props['9666'] ?? props['profile_scraping_privacy_token_in_photo_iq']
		if (profilePicProp !== undefined) {
			serverProps.profilePicPrivacyToken = profilePicProp === 'true' || profilePicProp === '1'
		}
		const lidIssueProp = props['14303'] ?? props['lid_trusted_token_issue_to_lid']
		if (lidIssueProp !== undefined) {
			serverProps.lidTrustedTokenIssueToLid = lidIssueProp === 'true' || lidIssueProp === '1'
		}
		logger.debug({ serverProps }, 'fetched props')
		return props
	}
	/**
	 * modify a chat -- mark unread, read etc.
	 * lastMessages must be sorted in reverse chronologically
	 * requires the last messages till the last message received; required for archive & unread
	 */
	const chatModify = (mod, jid) => {
		const patch = (0, Utils_1.chatModificationToAppPatch)(mod, jid)
		return appPatch(patch)
	}
	/**
	 * Enable/Disable link preview privacy, not related to baileys link preview generation
	 */
	const updateDisableLinkPreviewsPrivacy = isPreviewsDisabled => {
		return chatModify(
			{
				disableLinkPreviews: { isPreviewsDisabled }
			},
			''
		)
	}
	/**
	 * Star or Unstar a message
	 */
	const star = (jid, messages, star) => {
		return chatModify(
			{
				star: {
					messages,
					star
				}
			},
			jid
		)
	}
	/**
	 * Add or Edit Contact
	 */
	const addOrEditContact = (jid, contact) => {
		return chatModify(
			{
				contact
			},
			jid
		)
	}
	/**
	 * Remove Contact
	 */
	const removeContact = jid => {
		return chatModify(
			{
				contact: null
			},
			jid
		)
	}
	/**
	 * Adds label
	 */
	const addLabel = (jid, labels) => {
		return chatModify(
			{
				addLabel: {
					...labels
				}
			},
			jid
		)
	}
	/**
	 * Adds label for the chats
	 */
	const addChatLabel = (jid, labelId) => {
		return chatModify(
			{
				addChatLabel: {
					labelId
				}
			},
			jid
		)
	}
	/**
	 * Removes label for the chat
	 */
	const removeChatLabel = (jid, labelId) => {
		return chatModify(
			{
				removeChatLabel: {
					labelId
				}
			},
			jid
		)
	}
	/**
	 * Adds label for the message
	 */
	const addMessageLabel = (jid, messageId, labelId) => {
		return chatModify(
			{
				addMessageLabel: {
					messageId,
					labelId
				}
			},
			jid
		)
	}
	/**
	 * Removes label for the message
	 */
	const removeMessageLabel = (jid, messageId, labelId) => {
		return chatModify(
			{
				removeMessageLabel: {
					messageId,
					labelId
				}
			},
			jid
		)
	}
	/**
	 * Add or Edit Quick Reply
	 */
	const addOrEditQuickReply = quickReply => {
		return chatModify(
			{
				quickReply
			},
			''
		)
	}
	/**
	 * Remove Quick Reply
	 */
	const removeQuickReply = timestamp => {
		return chatModify(
			{
				quickReply: { timestamp, deleted: true }
			},
			''
		)
	}
	/**
	 * Rename an AI chat thread
	 */
	const renameAIThread = (jid, title) => {
		return chatModify({ aiThreadRename: { title } }, jid)
	}
	/**
	 * Pin or unpin a message in a thread/AI chat
	 */
	const pinThreadMessage = (jid, messageId, pinned = true) => {
		return chatModify({ threadPin: { pinned, messageId } }, jid)
	}
	/**
	 * Toggle AI private processing (end-to-end encrypted AI processing)
	 */
	const updatePrivateProcessingSetting = enabled => {
		return chatModify({ privateProcessingSetting: enabled ? 'enabled' : 'disabled' }, '')
	}
	/**
	 * Update Meta AI features control
	 * @param status 'enabled' | 'enabled_has_learning' | 'disabled'
	 * @param replyMode 'muted' | 'ai_agent' | 'suggestions'
	 */
	const updateAIFeatures = (status = 'enabled', replyMode = 'suggestions') => {
		const statusEnum =
			require('../../WAProto/index.js').proto.SyncActionValue.MaibaAIFeaturesControlAction.MaibaAIFeatureStatus
		const replyModeEnum =
			require('../../WAProto/index.js').proto.SyncActionValue.MaibaAIFeaturesControlAction.MaibaAIReplyMode
		const statusMap = {
			enabled: statusEnum.ENABLED,
			enabled_has_learning: statusEnum.ENABLED_HAS_LEARNING,
			disabled: statusEnum.DISABLED
		}
		const replyModeMap = {
			muted: replyModeEnum.MUTED,
			ai_agent: replyModeEnum.AI_AGENT,
			suggestions: replyModeEnum.SUGGESTIONS
		}
		return chatModify(
			{
				maibaAIFeatures: {
					status: statusMap[status] ?? statusEnum.ENABLED,
					replyMode: replyModeMap[replyMode] ?? replyModeEnum.SUGGESTIONS
				}
			},
			''
		)
	}
	/**
	 * Update bio/about privacy (who can see your About text)
	 * @param value 'all' | 'contacts' | 'contact_blacklist' | 'none'
	 */
	const updateBioPrivacy = async value => {
		await privacyQuery('about', value)
	}
	/**
	 * Block a bot JID
	 */
	const blockBot = async botJid => {
		await query({
			tag: 'iq',
			attrs: {
				xmlns: 'disappearing_mode',
				to: WABinary_1.S_WHATSAPP_NET,
				type: 'set'
			},
			content: [
				{
					tag: 'block',
					attrs: { jid: botJid }
				}
			]
		})
	}
	/**
	 * Unblock a bot JID
	 */
	const unblockBot = async botJid => {
		await updateBlockStatus(botJid, 'unblock')
	}
	/**
	 * Mute or unmute a contact's status updates
	 */
	const muteContactStatus = (jid, muted = true) => {
		return chatModify({ muteStatus: { muted } }, jid)
	}
	/**
	 * Add or remove a contact from favorites
	 */
	const toggleFavorite = (jid, isFavorite = true) => {
		return chatModify({ favorite: { isFavorite } }, jid)
	}
	/**
	 * Reorder labels
	 * @param sortedLabelIds ordered array of label IDs
	 */
	const reorderLabels = sortedLabelIds => {
		return chatModify({ reorderLabel: { sortedLabelIds } }, '')
	}
	/**
	 * Delete an individual call log entry
	 */
	const deleteCallLog = (callId, jid = '') => {
		return chatModify({ deleteCallLog: { callId } }, jid)
	}
	/**
	 * Create or update a note/draft for a chat
	 */
	const setChatNote = (jid, note) => {
		return chatModify({ noteEdit: { note } }, jid)
	}
	/**
	 * Delete the note/draft for a chat
	 */
	const deleteChatNote = jid => {
		return chatModify({ noteEdit: { note: '', deleted: true } }, jid)
	}
	/**
	 * Explicitly mark a chat as unread (shows unread dot even if read)
	 */
	const markChatAsUnread = (jid, lastMessages) => {
		return chatModify({ markAsUnread: true, lastMessages }, jid)
	}
	/**
	 * Set per-chat ephemeral message duration
	 * @param duration seconds (0 = off, 86400 = 1d, 604800 = 7d, 7776000 = 90d)
	 */
	const setChatEphemeral = (jid, duration) => {
		return chatModify({ setChatEphemeral: duration }, jid)
	}
	/**
	 * Silence a chat (mute without timestamp = permanent, or provide until timestamp)
	 */
	const silenceChat = (jid, silent = true, until = null) => {
		return chatModify({ silenceChat: { silent, until } }, jid)
	}
	/**
	 * Clear all messages in a chat
	 */
	const clearChat = (jid, lastMessages) => {
		return chatModify({ clear: true, lastMessages }, jid)
	}
	/**
	 * Pin or unpin a chat to the top
	 */
	const pinChat = (jid, pinned = true) => {
		return chatModify({ pin: { pinned } }, jid)
	}
	/**
	 * Star or unstar messages
	 */
	const starMessages = (jid, messageIds, starred = true) => {
		return chatModify({ star: { messages: messageIds, star: starred } }, jid)
	}
	/**
	 * Set up a quick reply
	 */
	const setQuickReply = (text, shortcut) => {
		return chatModify({ quickReply: { text, shortcut } }, '')
	}
	/**
	 * Fetch bot profiles for a list of JIDs using USyncBotProfileProtocol
	 */
	const fetchBotProfiles = async jids => {
		const { USyncQuery, USyncUser, USyncBotProfileProtocol } = require('../WAUSync')
		const q = new USyncQuery()
		q.protocols.push(new USyncBotProfileProtocol())
		for (const jid of jids) {
			q.withUser(new USyncUser().withId(jid))
		}
		const result = await executeUSyncQuery(q)
		return result?.list || []
	}
	/**
	 * Lock or unlock a chat with an optional secret code
	 */
	const updateChatLock = (jid, locked) => {
		return chatModify({ chatLock: { locked } }, jid)
	}
	/**
	 * Set a custom wallpaper for a chat
	 * @param jid the chat JID
	 * @param wallpaper wallpaper data or null to remove
	 */
	const updateChatWallpaper = (jid, wallpaper) => {
		if (!wallpaper) {
			return chatModify({ wallpaper: { remove: true } }, jid)
		}
		return chatModify({ wallpaper }, jid)
	}
	/**
	 * Set media visibility (auto-download) for a chat
	 * @param jid the chat JID
	 * @param visibility 'default' | 'on' | 'off'
	 */
	const updateChatMediaVisibility = (jid, visibility) => {
		return chatModify({ mediaVisibility: visibility }, jid)
	}
	/**
	 * Fetch details for a specific bot by JID
	 */
	const getBotProfile = async botJid => {
		const resp = await query({
			tag: 'iq',
			attrs: {
				xmlns: 'bot',
				to: WABinary_1.S_WHATSAPP_NET,
				type: 'get'
			},
			content: [
				{
					tag: 'bot',
					attrs: { v: '2', jid: botJid }
				}
			]
		})
		const botNode = (0, WABinary_1.getBinaryNodeChild)(resp, 'bot')
		if (!botNode) return null
		return {
			jid: botNode.attrs.jid,
			personaId: botNode.attrs['persona_id'],
			name: botNode.attrs.name,
			description: botNode.attrs.description
		}
	}
	/**
	 * Fetch AB-test (abt) props from server.
	 * Mirrors ABPropsProtocolHelper — protocol 1 or 2, optional hash/refresh_id/group.
	 * Confirmed from live capture: group-scoped queries send only { group }, never combined
	 * with protocol/hash/refresh_id; the account-level default protocol is "1", not "2".
	 */
	const fetchABProps = async (protocol = '1', hash = '', refreshId = null, group = null) => {
		const propAttrs =
			group != null
				? { group: String(group) }
				: {
						protocol,
						...(hash ? { hash } : {}),
						...(refreshId != null ? { refresh_id: String(refreshId) } : {})
					}
		const result = await query({
			tag: 'iq',
			attrs: { to: WABinary_1.S_WHATSAPP_NET, xmlns: 'abt', type: 'get' },
			content: [{ tag: 'props', attrs: propAttrs }]
		})
		const propsNode = (0, WABinary_1.getBinaryNodeChild)(result, 'props')
		if (!propsNode) return {}
		return (0, WABinary_1.reduceBinaryNodeToDictionary)(propsNode, 'prop')
	}
	/**
	 * Remove a companion (linked) device from the account.
	 * Mirrors CompanionDeviceRemovalJob — xmlns="md", child tag "remove-companion-device".
	 * jid: full device JID of the companion to remove (e.g. "1234567890:5@s.whatsapp.net").
	 * reason: "user_initiated" | "unknown_companion" | any WA-defined reason string.
	 * Confirmed from live capture — the previous { platform, id: keyIndex } attrs never
	 * identified a device at all; the server needs the companion's full jid.
	 */
	const removeCompanionDevice = async (jid, reason = 'user_initiated') => {
		await query({
			tag: 'iq',
			attrs: { to: WABinary_1.S_WHATSAPP_NET, xmlns: 'md', type: 'set' },
			content: [
				{
					tag: 'remove-companion-device',
					attrs: { jid, reason }
				}
			]
		})
	}
	/**
	 * Push an updated key-index-list to the server (multi-device key announcement).
	 * Mirrors KeyIndexListJob — xmlns="md", child tag "key-index-list" with a binary proto body.
	 * ts: unix timestamp seconds (string or number).
	 * content: Buffer — serialized proto KeyIndexList.
	 */
	const updateKeyIndexList = async (ts, content) => {
		await query({
			tag: 'iq',
			attrs: { to: WABinary_1.S_WHATSAPP_NET, xmlns: 'md', type: 'set' },
			content: [
				{
					tag: 'key-index-list',
					attrs: { ts: String(ts) },
					content
				}
			]
		})
	}
	/**
	 * Build and push the companion's signed key-index-list on (re)connect.
	 *
	 * The official client sends this within ~0.8s of every session start (xmlns="md").
	 * A companion that never re-asserts its ADV key index is treated as unverified and
	 * gets <conflict type="device_removed"/>.
	 *
	 * Payload construction mirrors CompanionDeviceAdvUtil.A02 (C19350ud) from the APK:
	 *   details            = proto ADVKeyIndexList { rawId, timestamp, currentIndex, validIndexes, accountType }
	 *   accountSignature   = Curve.sign(signedIdentityKey.private, [6,2] || details)
	 *   accountSignatureKey = only attached for HOSTED accounts (skipped for consumer E2EE)
	 * The signature uses our own device identity key (the same key that produces the ADV
	 * deviceSignature during pairing) — a companion cannot re-sign with the account key.
	 */
	const sendKeyIndexList = async () => {
		const account = authState.creds.account
		const signedIdentityKey = authState.creds.signedIdentityKey
		if (!account?.details || !signedIdentityKey?.private) {
			logger.debug('no ADV account / signed identity key, skipping key-index-list')
			return
		}
		const deviceIdentity = index_js_1.proto.ADVDeviceIdentity.decode(account.details)
		const keyIndex = deviceIdentity.keyIndex || 0
		const accountType = deviceIdentity.accountType ?? index_js_1.proto.ADVEncryptionType.E2EE
		const isHosted = accountType === index_js_1.proto.ADVEncryptionType.HOSTED
		const ts = Math.floor(Date.now() / 1000)
		const details = index_js_1.proto.ADVKeyIndexList.encode({
			rawId: deviceIdentity.rawId || 0,
			timestamp: ts,
			currentIndex: keyIndex,
			validIndexes: [keyIndex],
			accountType
		}).finish()
		const sigPrefix = isHosted
			? Defaults_1.WA_ADV_HOSTED_KEY_INDEX_LIST_SIG_PREFIX
			: Defaults_1.WA_ADV_KEY_INDEX_LIST_SIG_PREFIX
		const accountSignature = Utils_1.Curve.sign(signedIdentityKey.private, Buffer.concat([sigPrefix, details]))
		const signedKeyIndexList = { details, accountSignature }
		if (isHosted && account.accountSignatureKey?.length) {
			signedKeyIndexList.accountSignatureKey = account.accountSignatureKey
		}
		const content = index_js_1.proto.ADVSignedKeyIndexList.encode(signedKeyIndexList).finish()
		await updateKeyIndexList(ts, Buffer.from(content))
		logger.info({ ts, keyIndex }, 'sent key-index-list')
	}
	/**
	 * Request a media upload connection token from the server.
	 * Mirrors MediaConnFetcher — xmlns="w:m", type="set", optional last_id.
	 * Returns the raw media_conn node.
	 */
	const fetchMediaConn = async (lastId = null) => {
		const attrs = {}
		if (lastId != null) attrs.last_id = String(lastId)
		const result = await query({
			tag: 'iq',
			attrs: { to: WABinary_1.S_WHATSAPP_NET, xmlns: 'w:m', type: 'set' },
			content: [{ tag: 'media_conn', attrs }]
		})
		return (0, WABinary_1.getBinaryNodeChild)(result, 'media_conn') || null
	}
	/**
	 * Delete a broadcast list by ID.
	 * Mirrors BroadcastListDeleteJob — xmlns="w:b", wraps <delete><list id="..."/></delete>.
	 */
	const deleteBroadcastList = async listId => {
		await query({
			tag: 'iq',
			attrs: { to: WABinary_1.S_WHATSAPP_NET, xmlns: 'w:b', type: 'set' },
			content: [
				{
					tag: 'delete',
					attrs: {},
					content: [{ tag: 'list', attrs: { id: String(listId) } }]
				}
			]
		})
	}
	/**
	 * Fetch a QR code from the server (e.g. for linked-device linking).
	 * Mirrors QRCodeFetcher — xmlns="w:qr", type="get".
	 * addressingMode: "lid" | undefined — set to "lid" for LID-addressed QR.
	 */
	const fetchQRCode = async (code, addressingMode = null) => {
		const attrs = { code }
		if (addressingMode) attrs.addressing_mode = addressingMode
		const result = await query({
			tag: 'iq',
			attrs: { to: WABinary_1.S_WHATSAPP_NET, xmlns: 'w:qr', type: 'get' },
			content: [{ tag: 'qr', attrs }]
		})
		return (0, WABinary_1.getBinaryNodeChild)(result, 'qr') || null
	}
	/**
	 * Confirm or deny a device-logout request from the server.
	 * Mirrors AccountDefenceDeviceLogoutJob — xmlns="w:account_defence", smax_id=87.
	 * approve: true to confirm the logout, false to deny.
	 */
	const confirmDeviceLogout = async (id, approve = true) => {
		await query({
			tag: 'iq',
			attrs: {
				// reuse the challenge id at the iq level too, matching AccountDefenceDeviceLogoutJob
				id: String(id),
				to: WABinary_1.S_WHATSAPP_NET,
				xmlns: 'w:account_defence',
				type: 'set',
				smax_id: '87'
			},
			content: [
				{
					tag: 'device_logout',
					attrs: { approve: approve ? 'true' : 'false', id: String(id) }
				}
			]
		})
	}
	/**
	 * queries need to be fired on connection open
	 * help ensure parity with WA Web
	 * */
	const executeInitQueries = async () => {
		// Gate initInterop on previously-persisted flag: undefined = first connection (always run);
		// false = account has interop disabled, skip the TOS/opt-in flow on reconnect.
		const shouldInitInterop = authState.creds.interopEnabled !== false
		const [, , , abProps] = await Promise.all([
			fetchProps(),
			fetchBlocklist(),
			fetchPrivacySettings(),
			fetchABProps(),
			...(shouldInitInterop ? [initInterop()] : [])
		])
		const INTEROP_FLAGS = ['stella_interop_enabled', 'stella_ios_enabled']
		for (const flag of INTEROP_FLAGS) {
			if (flag in abProps) {
				const enabled = abProps[flag] === 'true' || abProps[flag] === '1'
				ev.emit('interop.feature-update', { feature: flag, enabled })
			}
		}
		// Persist AB prop feature flags into connection credentials so they survive reconnect.
		const abCredsUpdate = {}
		if ('stella_interop_enabled' in abProps) {
			abCredsUpdate.interopEnabled =
				abProps['stella_interop_enabled'] === 'true' || abProps['stella_interop_enabled'] === '1'
		}
		if ('stella_ios_enabled' in abProps) {
			abCredsUpdate.interopIosEnabled =
				abProps['stella_ios_enabled'] === 'true' || abProps['stella_ios_enabled'] === '1'
		}
		if ('md_privacy_v2' in abProps) {
			abCredsUpdate.mdPrivacyV2 = abProps['md_privacy_v2'] === 'true' || abProps['md_privacy_v2'] === '1'
		}
		// Persist media feature-flag AB props so upload/download paths can gate on them.
		const MEDIA_AB_PROPS = [
			'hd_image_dual_upload',
			'hd_video_dual_upload',
			'hevc_video_dual_upload',
			'partial_pjpeg_enabled',
			'multi_scan_pjpeg',
			'media_poll'
		]
		const mediaAbProps = {}
		for (const prop of MEDIA_AB_PROPS) {
			if (prop in abProps) {
				mediaAbProps[prop] = abProps[prop] === 'true' || abProps[prop] === '1'
			}
		}
		if (Object.keys(mediaAbProps).length) {
			abCredsUpdate.mediaAbProps = { ...(authState.creds.mediaAbProps || {}), ...mediaAbProps }
		}
		if (Object.keys(abCredsUpdate).length) {
			ev.emit('creds.update', abCredsUpdate)
		}
	}
	const upsertMessage = ev.createBufferedFunction(async (msg, type) => {
		// Cache newsletter server_id for use when this message is later quoted
		if (msg.newsletter && msg.newsletter_server_id && msg.key?.id) {
			_nlServerIdCache.set(msg.key.id, msg.newsletter_server_id)
		}
		// If this message quotes a newsletter post, enrich it with the cached server_id
		if (msg.message) {
			const ci = Object.values(msg.message).find(v => v?.contextInfo)?.contextInfo
			if (ci?.stanzaId && (0, WABinary_1.isJidNewsletter)(ci.remoteJid)) {
				const sid = _nlServerIdCache.get(ci.stanzaId)
				if (sid != null) msg.quotedNewsletterServerId = sid
			}
		}
		ev.emit('messages.upsert', { messages: [msg], type })
		if (!!msg.pushName) {
			let jid = msg.key.fromMe ? authState.creds.me.id : msg.key.participant || msg.key.remoteJid
			jid = (0, WABinary_1.jidNormalizedUser)(jid)
			if (!msg.key.fromMe) {
				ev.emit('contacts.update', [{ id: jid, notify: msg.pushName, verifiedName: msg.verifiedBizName }])
			}
			// update our pushname too
			if (msg.key.fromMe && msg.pushName && authState.creds.me?.name !== msg.pushName) {
				ev.emit('creds.update', { me: { ...authState.creds.me, name: msg.pushName } })
			}
		}
		const historyMsg = (0, Utils_1.getHistoryMsg)(msg.message)
		const shouldProcessHistoryMsg = historyMsg
			? shouldSyncHistoryMessage(historyMsg) && Defaults_1.PROCESSABLE_HISTORY_TYPES.includes(historyMsg.syncType)
			: false
		if (historyMsg && shouldProcessHistoryMsg) {
			const syncType = historyMsg.syncType
			// INITIAL_BOOTSTRAP — fire immediately, no progress check
			if (
				syncType === index_js_1.proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP &&
				!historySyncStatus.initialBootstrapComplete
			) {
				historySyncStatus.initialBootstrapComplete = true
				ev.emit('messaging-history.status', {
					syncType,
					status: 'complete',
					explicit: true
				})
			}
			// RECENT with progress === 100 — explicit completion
			if (
				syncType === index_js_1.proto.HistorySync.HistorySyncType.RECENT &&
				historyMsg.progress === 100 &&
				!historySyncStatus.recentSyncComplete
			) {
				historySyncStatus.recentSyncComplete = true
				clearTimeout(historySyncPausedTimeout)
				historySyncPausedTimeout = undefined
				ev.emit('messaging-history.status', {
					syncType,
					status: 'complete',
					explicit: true
				})
			}
			// Reset 120s paused timeout on any RECENT chunk
			if (syncType === index_js_1.proto.HistorySync.HistorySyncType.RECENT && !historySyncStatus.recentSyncComplete) {
				clearTimeout(historySyncPausedTimeout)
				historySyncPausedTimeout = setTimeout(() => {
					if (!historySyncStatus.recentSyncComplete) {
						historySyncStatus.recentSyncComplete = true
						ev.emit('messaging-history.status', {
							syncType: index_js_1.proto.HistorySync.HistorySyncType.RECENT,
							status: 'paused',
							explicit: false
						})
					}
					historySyncPausedTimeout = undefined
				}, Defaults_1.HISTORY_SYNC_PAUSED_TIMEOUT_MS)
			}
		}
		// State machine: decide on sync and flush
		if (historyMsg && syncState === State_1.SyncState.AwaitingInitialSync) {
			if (awaitingSyncTimeout) {
				clearTimeout(awaitingSyncTimeout)
				awaitingSyncTimeout = undefined
			}
			if (shouldProcessHistoryMsg) {
				syncState = State_1.SyncState.Syncing
				logger.info('Transitioned to Syncing state')
				// Let doAppStateSync handle the final flush after it's done
			} else {
				syncState = State_1.SyncState.Online
				logger.info('History sync skipped, transitioning to Online state and flushing buffer')
				ev.flush()
			}
		}
		const doAppStateSync = async () => {
			if (syncState === State_1.SyncState.Syncing) {
				// All collections will be synced, so clear any blocked ones
				blockedCollections.clear()
				logger.info('Doing app state sync')
				await resyncAppState(Types_1.ALL_WA_PATCH_NAMES, true)
				// Sync is complete, go online and flush everything
				syncState = State_1.SyncState.Online
				logger.info('App state sync complete, transitioning to Online state and flushing buffer')
				ev.flush()
				const accountSyncCounter = (authState.creds.accountSyncCounter || 0) + 1
				ev.emit('creds.update', { accountSyncCounter })
			}
		}
		await Promise.all([
			(async () => {
				if (shouldProcessHistoryMsg) {
					await doAppStateSync()
				}
			})(),
			(0, process_message_1.default)(msg, {
				signalRepository,
				shouldProcessHistoryMsg,
				placeholderResendCache,
				ev,
				creds: authState.creds,
				keyStore: authState.keys,
				logger,
				options: config.options,
				getMessage
			})
		])
		// If the app state key arrives and we are waiting to sync, trigger the sync now.
		if (msg.message?.protocolMessage?.appStateSyncKeyShare && syncState === State_1.SyncState.Syncing) {
			logger.info('App state sync key arrived, triggering app state sync')
			await doAppStateSync()
		}
	})
	ws.on('CB:presence', handlePresenceUpdate)
	ws.on('CB:chatstate', handlePresenceUpdate)
	// Server device-legitimacy challenge (w:account_defence). Fires a few seconds after the
	// companion sends its first message; if we don't approve within ~20s the device is removed
	// with <conflict type="device_removed"/>. Wire the inbound challenge to confirmDeviceLogout.
	ws.on('CB:iq,xmlns:w:account_defence', async node => {
		const deviceLogout = (0, WABinary_1.getBinaryNodeChild)(node, 'device_logout')
		if (!deviceLogout) return
		const id = node.attrs.id
		logger.info({ id }, 'received account_defence device_logout challenge, approving')
		try {
			await confirmDeviceLogout(id, true)
		} catch (error) {
			onUnexpectedError(error, 'account_defence device_logout approve')
		}
	})
	ws.on('CB:ib,,dirty', async node => {
		const { attrs } = (0, WABinary_1.getBinaryNodeChild)(node, 'dirty')
		const type = attrs.type
		switch (type) {
			case 'account_sync':
				if (attrs.timestamp) {
					let { lastAccountSyncTimestamp } = authState.creds
					if (lastAccountSyncTimestamp) {
						await cleanDirtyBits('account_sync', lastAccountSyncTimestamp)
					}
					lastAccountSyncTimestamp = +attrs.timestamp
					ev.emit('creds.update', { lastAccountSyncTimestamp })
				}
				break
			case 'groups':
				// handled in groups.ts
				break
			default:
				logger.info({ node }, 'received unknown sync')
				break
		}
	})
	ev.on('connection.update', ({ connection, receivedPendingNotifications }) => {
		if (connection === 'close') {
			blockedCollections.clear()
			clearTimeout(historySyncPausedTimeout)
			historySyncPausedTimeout = undefined
		}
		if (connection === 'open') {
			if (fireInitQueries) {
				executeInitQueries().catch(error => onUnexpectedError(error, 'init queries'))
			}
			sendPresenceUpdate(markOnlineOnConnect ? 'available' : 'unavailable').catch(error =>
				onUnexpectedError(error, 'presence update requests')
			)
			// Re-assert our ADV key index to the server on every (re)connect, or the companion
			// is treated as unverified and removed. Best-effort: never block the open flow.
			sendKeyIndexList().catch(error => onUnexpectedError(error, 'send key-index-list'))
		}
		if (!receivedPendingNotifications || syncState !== State_1.SyncState.Connecting) {
			return
		}
		historySyncStatus.initialBootstrapComplete = false
		historySyncStatus.recentSyncComplete = false
		clearTimeout(historySyncPausedTimeout)
		historySyncPausedTimeout = undefined
		syncState = State_1.SyncState.AwaitingInitialSync
		logger.info('Connection is now AwaitingInitialSync, buffering events')
		ev.buffer()
		const willSyncHistory = shouldSyncHistoryMessage(
			index_js_1.proto.Message.HistorySyncNotification.create({
				syncType: index_js_1.proto.HistorySync.HistorySyncType.RECENT
			})
		)
		if (!willSyncHistory) {
			logger.info('History sync is disabled by config, not waiting for notification. Transitioning to Online.')
			syncState = State_1.SyncState.Online
			setTimeout(() => ev.flush(), 0)
			return
		}
		// On reconnection (accountSyncCounter > 0), the server does not push
		// history sync notifications — the device already has its data.
		// Skip the 20s wait and go online immediately.
		if (authState.creds.accountSyncCounter > 0) {
			logger.info('Reconnection with existing sync data, skipping history sync wait. Transitioning to Online.')
			syncState = State_1.SyncState.Online
			setTimeout(() => ev.flush(), 0)
			return
		}
		logger.info('First connection, awaiting history sync notification with a 20s timeout.')
		if (awaitingSyncTimeout) {
			clearTimeout(awaitingSyncTimeout)
		}
		awaitingSyncTimeout = setTimeout(() => {
			if (syncState === State_1.SyncState.AwaitingInitialSync) {
				logger.warn('Timeout in AwaitingInitialSync, forcing state to Online and flushing buffer')
				syncState = State_1.SyncState.Online
				ev.flush()
				// Increment so subsequent reconnections skip the 20s wait.
				const accountSyncCounter = (authState.creds.accountSyncCounter || 0) + 1
				ev.emit('creds.update', { accountSyncCounter })
			}
		}, 20000)
	})
	// When an app state sync key arrives and there are collections blocked on a missing key, re-sync them.
	ev.on('creds.update', ({ myAppStateKeyId }) => {
		if (!myAppStateKeyId || blockedCollections.size === 0) {
			return
		}
		// If we're in the middle of a full sync, doAppStateSync handles all collections
		if (syncState === State_1.SyncState.Syncing) {
			blockedCollections.clear()
			return
		}
		const collections = [...blockedCollections]
		blockedCollections.clear()
		logger.info({ collections }, 'app state sync key arrived, re-syncing blocked collections')
		resyncAppState(collections, false).catch(error => onUnexpectedError(error, 'blocked collections resync'))
	})
	ev.on('lid-mapping.update', async ({ lid, pn }) => {
		try {
			await signalRepository.lidMapping.storeLIDPNMappings([{ lid, pn }])
		} catch (error) {
			logger.warn({ lid, pn, error }, 'Failed to store LID-PN mapping')
		}
	})
	return {
		...sock,
		serverProps,
		createCallLink,
		toggleCallLinkWaitingRoom,
		getBotListV2,
		getChatBlockingStatus,
		updateChatBlockingStatus,
		getUserDisclosures,
		acceptTosNotice,
		reportSpam,
		getOptOutList,
		getPushConfig,
		setPushConfig,
		signPrivateCredential,
		messageMutex,
		receiptMutex,
		appStatePatchMutex,
		notificationMutex,
		fetchPrivacySettings,
		upsertMessage,
		appPatch,
		sendPresenceUpdate,
		presenceSubscribe,
		profilePictureUrl,
		fetchBlocklist,
		fetchStatus,
		fetchDisappearingDuration,
		updateProfilePicture,
		removeProfilePicture,
		updateProfileStatus,
		updateProfileName,
		updateBlockStatus,
		updateDisableLinkPreviewsPrivacy,
		updateCallPrivacy,
		updateMessagesPrivacy,
		updateLastSeenPrivacy,
		updateOnlinePrivacy,
		updateProfilePicturePrivacy,
		updateStatusPrivacy,
		getStatusPrivacy,
		setStatusPrivacy,
		updateReadReceiptsPrivacy,
		updateGroupsAddPrivacy,
		updateDefaultDisappearingMode,
		fetchBroadcastListQuota,
		getBusinessProfile,
		resyncAppState,
		chatModify,
		cleanDirtyBits,
		addOrEditContact,
		removeContact,
		addLabel,
		addChatLabel,
		removeChatLabel,
		addMessageLabel,
		removeMessageLabel,
		star,
		addOrEditQuickReply,
		removeQuickReply,
		renameAIThread,
		pinThreadMessage,
		updatePrivateProcessingSetting,
		updateAIFeatures,
		updateBioPrivacy,
		blockBot,
		unblockBot,
		getBotProfile,
		muteContactStatus,
		toggleFavorite,
		reorderLabels,
		deleteCallLog,
		setChatNote,
		deleteChatNote,
		markChatAsUnread,
		setChatEphemeral,
		silenceChat,
		clearChat,
		pinChat,
		starMessages,
		setQuickReply,
		fetchBotProfiles,
		updateChatLock,
		updateChatWallpaper,
		updateChatMediaVisibility,
		fetchIntegrators,
		acceptInteropTOS,
		optInIntegrators,
		optOutIntegrators,
		resolveInteropUser,
		resolveInteropUsers,
		getReachabilitySettings,
		setReachabilitySettings,
		blockInteropUser,
		unblockInteropUser,
		reportInteropSpam,
		trustInteropContact,
		initInterop,
		createInteropGroup,
		leaveInteropGroup,
		getInteropGroupAddPrivacy,
		INTEGRATOR_BIRDYCHAT,
		INTEGRATOR_HAIKET,
		fetchABProps,
		removeCompanionDevice,
		updateKeyIndexList,
		fetchMediaConn,
		deleteBroadcastList,
		fetchQRCode,
		confirmDeviceLogout,
		updateKeyIndexList,
		sendKeyIndexList,
		storePrivacyTokens,
		executeUSyncQuery,
		newsletterServerIdCache: _nlServerIdCache
	}
}
exports.makeChatsSocket = makeChatsSocket
