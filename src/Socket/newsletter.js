'use strict'
Object.defineProperty(exports, '__esModule', { value: true })
exports.makeNewsletterSocket = void 0
const Types_1 = require('../Types')
const messages_media_1 = require('../Utils/messages-media')
const WABinary_1 = require('../WABinary')
const groups_1 = require('./groups')
const aigroups_1 = require('./aigroups')
const mex_1 = require('./mex')

/** Map a raw role string from the wire to the NewsletterRole enum. */
const mapNewsletterRole = raw => {
	if (!raw) return Types_1.NewsletterRole.GUEST
	const upper = String(raw).toUpperCase()
	switch (upper) {
		case 'OWNER':
			return Types_1.NewsletterRole.OWNER
		case 'ADMIN':
			return Types_1.NewsletterRole.ADMIN
		case 'SUBSCRIBER':
			return Types_1.NewsletterRole.SUBSCRIBER
		default:
			return Types_1.NewsletterRole.GUEST
	}
}

/** Map a raw state string from the wire to the NewsletterState enum. */
const mapNewsletterState = raw => {
	if (!raw) return Types_1.NewsletterState.UNKNOWN
	const upper = String(raw).toUpperCase()
	switch (upper) {
		case 'ACTIVE':
			return Types_1.NewsletterState.ACTIVE
		case 'SUSPENDED':
			return Types_1.NewsletterState.SUSPENDED
		case 'GEO_SUSPENDED':
			return Types_1.NewsletterState.GEO_SUSPENDED
		default:
			return Types_1.NewsletterState.UNKNOWN
	}
}

/** Map a raw reaction setting/codes value from the wire to the NewsletterReactionSetting enum. */
const mapReactionSetting = raw => {
	if (!raw) return Types_1.NewsletterReactionSetting.NONE
	const upper = String(raw).toUpperCase()
	switch (upper) {
		case 'ALLOWLIST':
			return Types_1.NewsletterReactionSetting.ALLOWLIST
		case 'BLOCKLIST':
			return Types_1.NewsletterReactionSetting.BLOCKLIST
		default:
			return Types_1.NewsletterReactionSetting.NONE
	}
}

/**
 * Enrich a raw newsletter metadata object with normalised protocol fields.
 * Handles both flat objects (direct API result) and objects that nest additional
 * data under thread_metadata / viewer_metadata.
 */
const mergeDsaCountries = (a, b) => {
	if (!a && !b) return null
	const merged = [...(Array.isArray(a) ? a : a ? [a] : []), ...(Array.isArray(b) ? b : b ? [b] : [])]
	return merged.length ? [...new Set(merged)] : null
}

const enrichNewsletterMetadata = raw => {
	if (!raw || typeof raw !== 'object') return raw
	const thread = raw.thread_metadata || {}
	const viewer = raw.viewer_metadata || {}
	const dsaCountries = mergeDsaCountries(
		thread.dsa_eligibility_countries ?? raw.dsa_eligibility_countries ?? null,
		thread.dsa_eligible_countries ?? raw.dsa_eligible_countries ?? null
	)
	return {
		...raw,
		role: mapNewsletterRole(viewer.role ?? raw.role),
		newsletterState: mapNewsletterState(raw.state ?? thread.state),
		reactionSetting: mapReactionSetting(
			thread.reaction_codes ?? thread.reaction_setting ?? raw.reaction_codes ?? raw.reaction_setting
		),
		dsaEligibilityCountries: dsaCountries,
		dsaDecision: thread.dsa_decision ?? raw.dsa_decision ?? null,
		pinnedMessage:
			thread.pinned_message_server_id ??
			thread.pinned_message_id ??
			raw.pinned_message_server_id ??
			raw.pinned_message_id ??
			null,
		hasQuestionsFeature: !!(thread.has_questions_feature ?? raw.has_questions_feature ?? false),
		hasMusicFeature: !!(
			thread.has_music_feature ??
			thread.music_enabled ??
			raw.has_music_feature ??
			raw.music_enabled ??
			false
		),
		viewsCount:
			thread.views_count != null
				? parseInt(thread.views_count, 10)
				: raw.views_count != null
					? parseInt(raw.views_count, 10)
					: null,
		subscriberCount:
			thread.subscriber_count != null
				? parseInt(thread.subscriber_count, 10)
				: raw.subscriber_count != null
					? parseInt(raw.subscriber_count, 10)
					: null
	}
}

const parseNewsletterCreateResponse = response => {
	const { id, thread_metadata: thread, viewer_metadata: viewer } = response
	const dsaCountries = mergeDsaCountries(
		thread.dsa_eligibility_countries ?? null,
		thread.dsa_eligible_countries ?? null
	)
	const base = {
		id: id,
		owner: undefined,
		name: thread.name.text,
		creation_time: parseInt(thread.creation_time, 10),
		description: thread.description.text,
		invite: thread.invite,
		subscribers: parseInt(thread.subscribers_count, 10),
		verification: thread.verification,
		picture: {
			id: thread.picture.id,
			directPath: thread.picture.direct_path
		},
		mute_state: viewer.mute,
		role: mapNewsletterRole(viewer.role),
		newsletterState: mapNewsletterState(thread.state),
		reactionSetting: mapReactionSetting(thread.reaction_codes ?? thread.reaction_setting),
		dsaEligibilityCountries: dsaCountries,
		dsaDecision: thread.dsa_decision ?? null,
		pinnedMessage: thread.pinned_message_server_id ?? thread.pinned_message_id ?? null,
		hasQuestionsFeature: !!(thread.has_questions_feature ?? false),
		hasMusicFeature: !!(thread.has_music_feature ?? thread.music_enabled ?? false)
	}
	return base
}
const parseNewsletterMetadata = result => {
	if (typeof result !== 'object' || result === null) {
		return null
	}
	if ('id' in result && typeof result.id === 'string') {
		return enrichNewsletterMetadata(result)
	}
	if ('result' in result && typeof result.result === 'object' && result.result !== null && 'id' in result.result) {
		return enrichNewsletterMetadata(result.result)
	}
	return null
}
const makeNewsletterSocket = config => {
	const sock = (0, aigroups_1.makeAIGroupsSocket)(config)
	const { query, generateMessageTag, sendNode } = sock
	const executeWMexQuery = (variables, queryId, dataPath) => {
		return (0, mex_1.executeWMexQuery)(variables, queryId, dataPath, query, generateMessageTag)
	}
	const newsletterUpdate = async (jid, updates) => {
		const variables = {
			newsletter_id: jid,
			updates: {
				...updates,
				settings: null
			}
		}
		return executeWMexQuery(variables, Types_1.QueryIds.UPDATE_METADATA, 'xwa2_newsletter_update')
	}
	return {
		...sock,
		newsletterCreate: async (name, description) => {
			const variables = {
				input: {
					name,
					description: description ?? null
				}
			}
			const rawResponse = await executeWMexQuery(
				variables,
				Types_1.QueryIds.CREATE,
				Types_1.XWAPaths.xwa2_newsletter_create
			)
			return parseNewsletterCreateResponse(rawResponse)
		},
		newsletterUpdate,
		newsletterSubscribers: async jid => {
			return executeWMexQuery(
				{ newsletter_id: jid },
				Types_1.QueryIds.SUBSCRIBERS,
				Types_1.XWAPaths.xwa2_newsletter_followers
			)
		},
		newsletterMetadata: async (type, key) => {
			const variables = {
				fetch_creation_time: true,
				fetch_full_image: true,
				fetch_viewer_metadata: true,
				input: {
					key,
					type: type.toUpperCase()
				}
			}
			const result = await executeWMexQuery(
				variables,
				Types_1.QueryIds.METADATA,
				Types_1.XWAPaths.xwa2_newsletter_metadata
			)
			return parseNewsletterMetadata(result)
		},
		newsletterFollow: jid => {
			return executeWMexQuery({ newsletter_id: jid }, Types_1.QueryIds.FOLLOW, Types_1.XWAPaths.xwa2_newsletter_join_v2)
		},
		newsletterUnfollow: jid => {
			return executeWMexQuery(
				{ newsletter_id: jid },
				Types_1.QueryIds.UNFOLLOW,
				Types_1.XWAPaths.xwa2_newsletter_leave_v2
			)
		},
		newsletterMute: jid => {
			return executeWMexQuery({ newsletter_id: jid }, Types_1.QueryIds.MUTE, Types_1.XWAPaths.xwa2_newsletter_mute_v2)
		},
		newsletterUnmute: jid => {
			return executeWMexQuery(
				{ newsletter_id: jid },
				Types_1.QueryIds.UNMUTE,
				Types_1.XWAPaths.xwa2_newsletter_unmute_v2
			)
		},
		newsletterUpdateName: async (jid, name) => {
			return await newsletterUpdate(jid, { name })
		},
		newsletterUpdateDescription: async (jid, description) => {
			return await newsletterUpdate(jid, { description })
		},
		newsletterUpdatePicture: async (jid, content) => {
			const { img } = await (0, messages_media_1.generateProfilePicture)(content)
			return await newsletterUpdate(jid, { picture: img.toString('base64') })
		},
		newsletterRemovePicture: async jid => {
			return await newsletterUpdate(jid, { picture: '' })
		},
		newsletterReactMessage: async (jid, serverId, reaction) => {
			await query({
				tag: 'message',
				attrs: {
					to: jid,
					...(reaction ? {} : { edit: '7' }),
					type: 'reaction',
					server_id: serverId,
					id: generateMessageTag()
				},
				content: [
					{
						tag: 'reaction',
						attrs: reaction ? { code: reaction } : {}
					}
				]
			})
		},
		newsletterFetchMessages: async (jid, count, since, after) => {
			const messageUpdateAttrs = {
				count: count.toString()
			}
			if (typeof since === 'number') {
				messageUpdateAttrs.since = since.toString()
			}
			if (after) {
				messageUpdateAttrs.after = after.toString()
			}
			const result = await query({
				tag: 'iq',
				attrs: {
					id: generateMessageTag(),
					type: 'get',
					xmlns: 'newsletter',
					to: jid
				},
				content: [
					{
						tag: 'message_updates',
						attrs: messageUpdateAttrs
					}
				]
			})
			return result
		},
		/**
		 * Find the numeric server_id for a newsletter message by its WhatsApp message ID.
		 * Fetches the last `limit` messages and scans attrs for a matching message_id.
		 */
		newsletterGetServerId: async (jid, messageId, limit = 50) => {
			console.log('[newsletterGetServerId] called jid:', jid, 'messageId:', messageId)
			let result
			try {
				result = await query(
					{
						tag: 'iq',
						attrs: {
							id: generateMessageTag(),
							type: 'get',
							xmlns: 'newsletter',
							to: jid
						},
						content: [{ tag: 'message_updates', attrs: { count: String(limit) } }]
					},
					5000
				)
			} catch (e) {
				console.log('[newsletterGetServerId] query error/timeout:', e?.message)
				return null
			}
			console.log('[newsletterGetServerId] result tag:', result?.tag, 'attrs:', JSON.stringify(result?.attrs))
			if (!result) return null
			const updatesNode = (0, WABinary_1.getBinaryNodeChild)(result, 'message_updates')
			const messages = (0, WABinary_1.getBinaryNodeChildren)(updatesNode ?? result, 'message')
			console.log(
				'[newsletterGetServerId] messages count:',
				messages.length,
				'first attrs:',
				JSON.stringify(messages[0]?.attrs)
			)
			for (const msg of messages) {
				if (msg.attrs.message_id === messageId || msg.attrs.id === messageId) {
					return msg.attrs.server_id ? +msg.attrs.server_id : null
				}
			}
			return null
		},
		subscribeNewsletterUpdates: async jid => {
			const result = await query({
				tag: 'iq',
				attrs: {
					id: generateMessageTag(),
					type: 'set',
					xmlns: 'newsletter',
					to: jid
				},
				content: [{ tag: 'live_updates', attrs: {}, content: [] }]
			})
			const liveUpdatesNode = (0, WABinary_1.getBinaryNodeChild)(result, 'live_updates')
			const duration = liveUpdatesNode?.attrs?.duration
			return duration ? { duration: duration } : null
		},
		newsletterAdminCount: async jid => {
			const response = await executeWMexQuery(
				{ newsletter_id: jid },
				Types_1.QueryIds.ADMIN_COUNT,
				Types_1.XWAPaths.xwa2_newsletter_admin_count
			)
			return response.admin_count
		},
		newsletterChangeOwner: async (jid, newOwnerJid) => {
			await executeWMexQuery(
				{ newsletter_id: jid, user_id: newOwnerJid },
				Types_1.QueryIds.CHANGE_OWNER,
				Types_1.XWAPaths.xwa2_newsletter_change_owner
			)
		},
		newsletterDemote: async (jid, userJid) => {
			await executeWMexQuery(
				{ newsletter_id: jid, user_id: userJid },
				Types_1.QueryIds.DEMOTE,
				Types_1.XWAPaths.xwa2_newsletter_admin_demote
			)
		},
		newsletterDelete: async jid => {
			await executeWMexQuery(
				{ newsletter_id: jid },
				Types_1.QueryIds.DELETE,
				Types_1.XWAPaths.xwa2_newsletter_delete_v2
			)
		},
		/**
		 * Update newsletter category/topic
		 */
		newsletterUpdateCategory: async (jid, category) => {
			return newsletterUpdate(jid, { topic: category })
		},
		/**
		 * Update newsletter invite codes / settings
		 */
		newsletterUpdateSettings: async (jid, settings) => {
			const variables = { newsletter_id: jid, updates: { settings } }
			return executeWMexQuery(variables, Types_1.QueryIds.UPDATE_METADATA, 'xwa2_newsletter_update')
		},
		/**
		 * Promote a subscriber to admin
		 */
		newsletterPromoteAdmin: async (jid, userJid) => {
			await query({
				tag: 'iq',
				attrs: {
					id: generateMessageTag(),
					type: 'set',
					xmlns: 'newsletter',
					to: jid
				},
				content: [
					{
						tag: 'admin_promote',
						attrs: {},
						content: [{ tag: 'participant', attrs: { jid: userJid } }]
					}
				]
			})
		},
		/**
		 * Get newsletter view/reach statistics
		 */
		newsletterViewStats: async (jid, serverId) => {
			const result = await query({
				tag: 'iq',
				attrs: {
					id: generateMessageTag(),
					type: 'get',
					xmlns: 'newsletter',
					to: jid
				},
				content: [
					{
						tag: 'message_updates',
						attrs: { count: '1', server_id: String(serverId) }
					}
				]
			})
			return result
		},
		/**
		 * Send a newsletter post via IQ (alternative to sendMessage for newsletters)
		 */
		newsletterSendPost: async (jid, content, options = {}) => {
			const result = await query({
				tag: 'iq',
				attrs: {
					id: generateMessageTag(),
					type: 'set',
					xmlns: 'newsletter',
					to: jid
				},
				content: [
					{
						tag: 'publish',
						attrs: {},
						content: Array.isArray(content) ? content : [content]
					}
				]
			})
			return result
		},
		/**
		 * Revoke (delete) a message posted to a newsletter.
		 * @param {string} jid - Newsletter JID
		 * @param {number|string} serverId - server_id of the message to revoke
		 */
		newsletterRevokeMessage: async (jid, serverId) => {
			await sendNode({
				tag: 'message',
				attrs: {
					to: jid,
					type: 'text',
					edit: '7',
					server_id: String(serverId),
					id: generateMessageTag()
				},
				content: []
			})
		},
		/**
		 * Pin a newsletter message
		 */
		newsletterPinMessage: async (jid, serverId, durationSecs = 86400) => {
			await query({
				tag: 'iq',
				attrs: {
					id: generateMessageTag(),
					type: 'set',
					xmlns: 'newsletter',
					to: jid
				},
				content: [
					{
						tag: 'pin',
						attrs: { server_id: String(serverId), duration: String(durationSecs) }
					}
				]
			})
		},
		/**
		 * Unpin a newsletter message
		 */
		newsletterUnpinMessage: async (jid, serverId) => {
			await query({
				tag: 'iq',
				attrs: {
					id: generateMessageTag(),
					type: 'set',
					xmlns: 'newsletter',
					to: jid
				},
				content: [
					{
						tag: 'unpin',
						attrs: { server_id: String(serverId) }
					}
				]
			})
		},
		/**
		 * Invite a user to become an admin of a newsletter.
		 *
		 * @param {string} jid - Newsletter JID
		 * @param {string} userJid - JID of the user to invite
		 */
		newsletterInviteAdmin: async (jid, userJid) => {
			return executeWMexQuery(
				{ newsletter_id: jid, user_id: userJid },
				Types_1.QueryIds.ADMIN_INVITE,
				Types_1.XWAPaths.xwa2_newsletter_admin_invite_create
			)
		},
		/**
		 * Revoke a pending admin invite for a newsletter.
		 *
		 * @param {string} jid - Newsletter JID
		 * @param {string} userJid - JID of the invited user to revoke
		 */
		newsletterRevokeAdminInvite: async (jid, userJid) => {
			return executeWMexQuery(
				{ newsletter_id: jid, user_id: userJid },
				Types_1.QueryIds.ADMIN_INVITE_REVOKE,
				Types_1.XWAPaths.xwa2_newsletter_admin_invite_revoke
			)
		},
		/**
		 * Accept an admin invite to a newsletter (called by the invitee).
		 *
		 * @param {string} jid - Newsletter JID
		 */
		newsletterAcceptAdminInvite: async jid => {
			return executeWMexQuery(
				{ newsletter_id: jid },
				Types_1.QueryIds.ADMIN_INVITE_ACCEPT,
				Types_1.XWAPaths.xwa2_newsletter_admin_invite_accept
			)
		},
		/**
		 * Fetch admin-side metadata for a newsletter.
		 *
		 * @param {string} jid - Newsletter JID
		 * @param {object} options
		 *   @param {boolean} [options.fetchPendingAdmins=true]
		 *   @param {boolean} [options.fetchAdminCount=true]
		 *   @param {boolean} [options.fetchCapabilities=false]
		 *   @param {boolean} [options.fetchAdminProfile=false]
		 *   @param {boolean} [options.includeAdminSettings=false]
		 *   @param {boolean} [options.includeJarvisConfig=false]
		 */
		newsletterAdminMetadata: async (jid, options = {}) => {
			const {
				fetchPendingAdmins = true,
				fetchAdminCount = true,
				fetchCapabilities = false,
				fetchAdminProfile = false,
				includeAdminSettings = false,
				includeJarvisConfig = false
			} = options
			return executeWMexQuery(
				{
					jid,
					include_thread_metadata: false,
					include_messages: false,
					fetch_pending_admin_invites: fetchPendingAdmins,
					fetch_admin_count: fetchAdminCount,
					fetch_capabilities: fetchCapabilities,
					fetch_admin_profile: fetchAdminProfile,
					include_admin_settings: includeAdminSettings,
					include_jarvis_config: includeJarvisConfig
				},
				Types_1.QueryIds.ADMIN_METADATA,
				Types_1.XWAPaths.xwa2_newsletter_admin
			)
		},
		/**
		 * Update admin profile fields for a newsletter (e.g. contact info, links).
		 *
		 * @param {string} jid - Newsletter JID
		 * @param {object} updates - Admin profile fields to update
		 */
		newsletterAdminProfileUpdate: async (jid, updates) => {
			return executeWMexQuery(
				{ newsletter_id: jid, updates },
				Types_1.QueryIds.ADMIN_PROFILE_UPDATE,
				Types_1.XWAPaths.xwa2_newsletter_admin_profile_update
			)
		},
		/**
		 * Browse the newsletter directory by category.
		 *
		 * @param {object} options
		 *   @param {number} [options.limit=20]
		 *   @param {string[]} [options.interests] - Category filters
		 *   @param {string} [options.sortField='SUBSCRIBER_COUNT']
		 *   @param {string} [options.sortOrder='DESC']
		 */
		newsletterDirectoryList: async (options = {}) => {
			const { limit = 20, interests = null, sortField = 'SUBSCRIBER_COUNT', sortOrder = 'DESC' } = options
			const variables = { limit, sort_field: sortField, sort_order: sortOrder }
			if (interests?.length) variables.interests = interests
			return executeWMexQuery(
				variables,
				Types_1.QueryIds.DIRECTORY_LIST,
				Types_1.XWAPaths.xwa2_newsletters_directory_list
			)
		},
		/**
		 * Search the newsletter directory.
		 *
		 * @param {string} searchText - Search query string
		 * @param {object} options
		 *   @param {number} [options.limit=20]
		 *   @param {string} [options.startCursor] - Pagination cursor
		 *   @param {string[]} [options.categories] - Category filters
		 */
		newsletterDirectorySearch: async (searchText, options = {}) => {
			const { limit = 20, startCursor = null, categories = null } = options
			const variables = { search_text: searchText, limit }
			if (startCursor) variables.start_cursor = startCursor
			if (categories?.length) variables.categories = categories
			return executeWMexQuery(
				variables,
				Types_1.QueryIds.DIRECTORY_SEARCH,
				Types_1.XWAPaths.xwa2_newsletters_directory_search
			)
		},
		/**
		 * Fetch a preview of newsletters grouped by directory category.
		 *
		 * @param {number} [limit=5] - Newsletters per category
		 */
		newsletterDirectoryCategoryPreview: async (limit = 5) => {
			return executeWMexQuery(
				{ limit },
				Types_1.QueryIds.DIRECTORY_CATEGORY_PREVIEW,
				Types_1.XWAPaths.xwa2_newsletters_directory_category_preview
			)
		},
		/**
		 * Search for newsletters by text query.
		 *
		 * @param {string} query - Search string
		 * @param {number} [limit=20]
		 * @param {string} [startCursor] - Pagination cursor
		 */
		newsletterSearch: async (query, limit = 20, startCursor = null) => {
			const variables = { query, limit }
			if (startCursor) variables.start_cursor = startCursor
			return executeWMexQuery(variables, Types_1.QueryIds.SEARCH, Types_1.XWAPaths.xwa2_newsletters_search)
		},
		/**
		 * Fetch recommended newsletters.
		 *
		 * @param {number} [limit=10]
		 * @param {number} [numFollowed] - Number of newsletters the user already follows (used for ranking)
		 */
		newsletterRecommended: async (limit = 10, numFollowed = null) => {
			const variables = { limit }
			if (numFollowed != null) variables.num_newsletters_followed = numFollowed
			return executeWMexQuery(variables, Types_1.QueryIds.RECOMMENDED, Types_1.XWAPaths.xwa2_newsletters_recommended)
		},
		/**
		 * Fetch newsletters similar to a given newsletter.
		 *
		 * @param {string} jid - Newsletter JID to find similar newsletters for
		 * @param {number} [limit=10]
		 */
		newsletterSimilar: async (jid, limit = 10) => {
			return executeWMexQuery(
				{ newsletter_id: jid, limit },
				Types_1.QueryIds.SIMILAR,
				Types_1.XWAPaths.xwa2_newsletters_similar
			)
		},
		/**
		 * Fetch the list of newsletters the current user is following.
		 *
		 * @param {string} [startCursor] - Pagination cursor
		 * @param {number} [limit=20]
		 */
		newsletterFollowingList: async (startCursor = null, limit = 20) => {
			const variables = { limit }
			if (startCursor) variables.start_cursor = startCursor
			return executeWMexQuery(variables, Types_1.QueryIds.FOLLOWING_LIST, Types_1.XWAPaths.xwa2_newsletter_following)
		},
		/**
		 * Fetch admin insights/analytics for a newsletter.
		 *
		 * @param {string} jid - Newsletter JID
		 * @param {string} [period] - Time period e.g. 'LAST_7_DAYS', 'LAST_30_DAYS'
		 */
		newsletterInsights: async (jid, period = null) => {
			const variables = { newsletter_id: jid }
			if (period) variables.period = period
			return executeWMexQuery(variables, Types_1.QueryIds.INSIGHTS, Types_1.XWAPaths.xwa2_newsletter_admin_insights)
		},
		/**
		 * Fetch the list of users who voted in a newsletter poll.
		 *
		 * @param {string} jid - Newsletter JID
		 * @param {string} serverId - Server-side message ID of the poll
		 * @param {string} [option] - Poll option to filter voters by
		 * @param {string} [startCursor] - Pagination cursor
		 */
		newsletterPollVoterList: async (jid, serverId, option = null, startCursor = null) => {
			const variables = { id: jid, server_id: serverId }
			if (option != null) variables.option = option
			if (startCursor) variables.start_cursor = startCursor
			return executeWMexQuery(
				variables,
				Types_1.QueryIds.POLL_VOTER_LIST,
				Types_1.XWAPaths.xwa2_newsletters_poll_voter_list
			)
		},
		/**
		 * Fetch the list of users who reacted to a newsletter message.
		 *
		 * @param {string} jid - Newsletter JID
		 * @param {string} serverId - Server-side message sort ID
		 * @param {string} [startCursor] - Pagination cursor
		 */
		newsletterReactionSenders: async (jid, serverId, startCursor = null) => {
			const variables = { id: jid, server_id: serverId }
			if (startCursor) variables.start_cursor = startCursor
			return executeWMexQuery(
				variables,
				Types_1.QueryIds.REACTION_SENDERS_LIST,
				Types_1.XWAPaths.xwa2_newsletters_reaction_sender_list
			)
		},
		/**
		 * Block a user from a newsletter (admin action).
		 *
		 * @param {string} jid - Newsletter JID
		 * @param {string} userJid - JID of the user to block
		 */
		newsletterBlockUser: async (jid, userJid) => {
			return executeWMexQuery(
				{ newsletter_id: jid, user_id: userJid },
				Types_1.QueryIds.BLOCK_USER,
				'xwa2_newsletter_block_user'
			)
		},
		/**
		 * Enable Wamo (paid subscription) for a newsletter.
		 *
		 * @param {string} jid - Newsletter JID
		 */
		newsletterEnableWamo: async jid => {
			return executeWMexQuery(
				{ newsletter_id: jid },
				Types_1.QueryIds.WAMO_ENABLE_SUB,
				'xwa2_newsletter_wamo_enable_sub'
			)
		},
		/**
		 * Disable Wamo (paid subscription) for a newsletter.
		 *
		 * @param {string} jid - Newsletter JID
		 */
		newsletterDisableWamo: async jid => {
			return executeWMexQuery(
				{ newsletter_id: jid },
				Types_1.QueryIds.WAMO_DISABLE_SUB,
				'xwa2_newsletter_wamo_disable_sub'
			)
		},
		/**
		 * Change the Wamo subscription tier or settings for a newsletter.
		 *
		 * @param {string} jid - Newsletter JID
		 * @param {object} subConfig - Subscription configuration (tier, price, etc.)
		 */
		newsletterChangeWamo: async (jid, subConfig) => {
			return executeWMexQuery(
				{ newsletter_id: jid, ...subConfig },
				Types_1.QueryIds.WAMO_CHANGE_SUB,
				'xwa2_newsletter_wamo_change_sub'
			)
		},
		/**
		 * Fetch Wamo AFS age collection data.
		 * @param {string} jid - Newsletter JID
		 */
		wamoAfsAgeCollection: async jid =>
			executeWMexQuery(
				{ newsletter_id: jid },
				Types_1.QueryIds.WAMO_AFS_AGE_COLLECTION,
				Types_1.XWAPaths.xwa2_wamo_afs_age_collection
			),
		/**
		 * Fetch Wamo asset collection (images/assets for Wamo UI).
		 * @param {string} jid - Newsletter JID
		 */
		wamoAssetCollection: async jid =>
			executeWMexQuery(
				{ newsletter_id: jid },
				Types_1.QueryIds.WAMO_ASSET_COLLECTION,
				Types_1.XWAPaths.xwa2_wamo_asset_collection
			),
		/**
		 * Fetch a Wamo ad-hoc notice by ID.
		 * @param {string} noticeId - Notice ID to fetch
		 */
		wamoFetchAdhocNotice: async noticeId =>
			executeWMexQuery(
				{ notice_id: noticeId },
				Types_1.QueryIds.WAMO_FETCH_ADHOC_NOTICE,
				Types_1.XWAPaths.xwa2_wamo_fetch_adhoc_notice_by_id
			),
		/**
		 * Fetch the Wamo identity token for a newsletter.
		 * @param {string} jid - Newsletter JID
		 */
		wamoFetchIdentityToken: async jid =>
			executeWMexQuery(
				{ newsletter_id: jid },
				Types_1.QueryIds.WAMO_FETCH_IDENTITY_TOKEN,
				Types_1.XWAPaths.xwa2_wamo_fetch_identity_token
			),
		/**
		 * Get Wamo subscription compliance info.
		 * @param {string} jid - Newsletter JID
		 */
		wamoSubComplianceInfo: async jid =>
			executeWMexQuery(
				{ newsletter_id: jid },
				Types_1.QueryIds.WAMO_SUB_COMPLIANCE_INFO,
				Types_1.XWAPaths.xwa2_wamo_sub_get_compliance_info
			),
		/**
		 * Get the Wamo user ID version for a newsletter.
		 * @param {string} jid - Newsletter JID
		 */
		wamoUserIdVersion: async jid =>
			executeWMexQuery(
				{ newsletter_id: jid },
				Types_1.QueryIds.WAMO_USER_ID_VERSION,
				Types_1.XWAPaths.xwa2_wamo_user_id_version
			),
		/**
		 * Set the Wamo user ID version for a newsletter.
		 * @param {string} jid - Newsletter JID
		 * @param {number} version - Version to set
		 */
		wamoSetUserIdVersion: async (jid, version) =>
			executeWMexQuery(
				{ newsletter_id: jid, version },
				Types_1.QueryIds.WAMO_SET_USER_ID_VERSION,
				Types_1.XWAPaths.xwa2_wamo_set_user_id_version
			),
		/**
		 * Leave a newsletter (unsubscribe).
		 * @param {string} jid - Newsletter JID
		 */
		newsletterLeave: async jid =>
			executeWMexQuery({ newsletter_id: jid }, Types_1.QueryIds.LEAVE, Types_1.XWAPaths.xwa2_newsletter_leave_v2),
		/**
		 * Create a verified newsletter.
		 * @param {string} name - Newsletter name
		 * @param {string} [description]
		 */
		newsletterCreateVerified: async (name, description = null) =>
			executeWMexQuery(
				{ input: { name, description } },
				Types_1.QueryIds.CREATE_VERIFIED,
				Types_1.XWAPaths.xwa2_newsletter_create_verified
			),
		/**
		 * Fetch newsletter enforcements (ban/restriction info).
		 * @param {string} jid - Newsletter JID
		 */
		newsletterEnforcements: async jid =>
			executeWMexQuery(
				{ newsletter_id: jid },
				Types_1.QueryIds.ENFORCEMENTS,
				Types_1.XWAPaths.xwa2_newsletter_enforcements
			),
		/**
		 * Fetch user reports for a newsletter (admin action).
		 * @param {string} jid - Newsletter JID
		 * @param {string} [cursor] - Pagination cursor
		 */
		newsletterUserReports: async (jid, cursor = null) => {
			const variables = { newsletter_id: jid }
			if (cursor) variables.cursor = cursor
			return executeWMexQuery(variables, Types_1.QueryIds.USER_REPORTS, Types_1.XWAPaths.xwa2_newsletter_user_reports)
		},
		/**
		 * Create a report appeal for a newsletter.
		 * @param {string} jid - Newsletter JID
		 * @param {string} reason - Appeal reason text
		 */
		newsletterCreateReportAppeal: async (jid, reason) =>
			executeWMexQuery(
				{ newsletter_id: jid, reason },
				Types_1.QueryIds.CREATE_REPORT_APPEAL,
				Types_1.XWAPaths.xwa2_newsletter_create_report_appeal
			),
		/**
		 * Check a newsletter link preview.
		 * @param {string} url - URL to preview
		 */
		newsletterLinkPreviewCheck: async url =>
			executeWMexQuery(
				{ url },
				Types_1.QueryIds.LINK_PREVIEW_CHECK,
				Types_1.XWAPaths.xwa2_newsletter_link_preview_check
			),
		/**
		 * Update newsletter verification status (admin/platform action).
		 * @param {string} jid - Newsletter JID
		 * @param {string} verification - Verification status
		 */
		newsletterUpdateVerification: async (jid, verification) =>
			executeWMexQuery(
				{ newsletter_id: jid, verification },
				Types_1.QueryIds.UPDATE_VERIFICATION,
				Types_1.XWAPaths.xwa2_newsletter_update_verification
			),
		/**
		 * Label a newsletter post as paid partnership.
		 * @param {string} jid - Newsletter JID
		 * @param {string} serverId - Server message ID
		 * @param {boolean} isPaidPartnership
		 */
		newsletterLabelPaidPartnership: async (jid, serverId, messageType = 'MESSAGE') =>
			executeWMexQuery(
				{ newsletter_id: jid, server_id: String(serverId), message_type: messageType },
				Types_1.QueryIds.LABEL_PAID_PARTNERSHIP,
				Types_1.XWAPaths.xwa2_newsletter_label_paid_partnership
			),
		/**
		 * Log newsletter exposure events (analytics).
		 * @param {{ newsletter_id: string, exposure_type: string }[]} events
		 */
		newsletterLogExposures: async events =>
			executeWMexQuery({ events }, Types_1.QueryIds.LOG_EXPOSURES, Types_1.XWAPaths.xwa2_newsletter_log_exposures),
		/**
		 * Update user-specific newsletter setting (e.g. notification prefs).
		 * @param {string} jid - Newsletter JID
		 * @param {object} setting - Setting key/value
		 */
		newsletterUpdateUserSetting: async (jid, setting) =>
			executeWMexQuery(
				{ newsletter_id: jid, ...setting },
				Types_1.QueryIds.UPDATE_USER_SETTING,
				Types_1.XWAPaths.xwa2_newsletter_update_user_setting
			),
		/**
		 * Fetch newsletter ranking features (ML signals).
		 * @param {string} jid - Newsletter JID
		 */
		newsletterRankingFeatures: async jid =>
			executeWMexQuery(
				{ newsletter_id: jid },
				Types_1.QueryIds.RANKING_FEATURES,
				Types_1.XWAPaths.xwa2_newsletter_ranking_features
			),
		/**
		 * Fetch account reachout timelock (rate-limit state for outreach actions).
		 */
		fetchReachoutTimelock: async () =>
			executeWMexQuery({}, Types_1.QueryIds.REACHOUT_TIMELOCK, Types_1.XWAPaths.xwa2_fetch_account_reachout_timelock),
		/**
		 * Fetch message capping info (daily/weekly send limit status).
		 */
		fetchMessageCappingInfo: async () =>
			executeWMexQuery({}, Types_1.QueryIds.MESSAGE_CAPPING_INFO, Types_1.XWAPaths.xwa2_message_capping_info),
		/**
		 * Update the response state for a question in a newsletter message.
		 * @param {string} jid - Newsletter JID
		 * @param {string} serverId - Server message ID of the question
		 * @param {string} state - New response state (e.g. 'OPEN', 'CLOSED')
		 */
		newsletterQuestionResponseStateUpdate: async (jid, serverId, state) =>
			executeWMexQuery(
				{ newsletter_id: jid, server_id: serverId, state },
				Types_1.QueryIds.QUESTION_RESPONSE_STATE_UPDATE,
				Types_1.XWAPaths.xwa2_newsletter_question_response_state_update
			),
		/**
		 * Send view receipts for newsletter messages (marks them as seen).
		 * serverMessageIds: array of numeric server-side message IDs.
		 * Mirrors SendViewReceiptJob in the APK — builds a receipt stanza
		 * with type="view" and a <list> of <item server_id="..."/> children.
		 */
		newsletterSendViewReceipt: async (jid, serverMessageIds) => {
			const ids = Array.isArray(serverMessageIds) ? serverMessageIds : [serverMessageIds]
			const receiptId = generateMessageTag()
			await query({
				tag: 'receipt',
				attrs: {
					to: jid,
					id: receiptId,
					type: 'view'
				},
				content: [
					{
						tag: 'list',
						attrs: {},
						content: ids.map(id => ({ tag: 'item', attrs: { server_id: String(id) } }))
					}
				]
			})
		}
	}
}
exports.makeNewsletterSocket = makeNewsletterSocket
