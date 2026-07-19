'use strict'
Object.defineProperty(exports, '__esModule', { value: true })
exports.extractGroupMetadata = exports.makeGroupsSocket = void 0
const index_js_1 = require('../../WAProto/index.js')
const Types_1 = require('../Types')
const Utils_1 = require('../Utils')
const WABinary_1 = require('../WABinary')
const chats_1 = require('./chats')
const mex_1 = require('./mex')

const GROUP_MEX_QUERY_IDS = {
	QUERY_INFO: '25530136513328492', // QueryGroupInfo
	QUERY_INFO_BY_CODE: '24576337542042464', // QueryGroupInfoByCode
	QUERY_BATCH: '26440064815661176', // QueryBatchGetGroups
	QUERY_INVITE_LINK: '24558418350455204', // QueryInviteLink
	QUERY_PARTICIPATING: '26664341543184776', // QueryParticipatingGroups
	QUERY_SUGGESTED: '26012055225051916', // QuerySuggestedGroups
	QUERY_LINKED: '25629003043401452', // QueryLinkedGroupInfo
	QUERY_SUBGROUPS: '25554052094203120', // QuerySubgroups
	ADD_PARTICIPANTS_V2: '32627550323510250', // AddParticipantsToGroupV2
	ADD_PARTICIPANTS_V3: '26581073158212628', // AddParticipantsToGroupsV3
	SET_PROPERTY: '24688994337458820', // SetGroupProperty
	RESET_INVITE_LINK: '24812851838367452', // SetGroupResetInviteLink
	CREATE_INVITE_CODE: '25207706598901440', // CreateInviteCode
	CREATE_GROUP: '32341779532133480', // CreateGroup
	ALLOW_NON_ADMIN_GROUP_CREATION: '32024438593867696', // AllowNonAdminGroupCreation
	GET_INVITE_INFO: '24745668928467084', // GetInviteInfo
	GET_PRE_REG_ADD_REQUESTS: '25018599251091280', // GetPreRegGroupAddRequestsQuery
	GET_SUGGESTED_CONTACTS: '27208468032086900', // GetSuggestedContacts
	STORE_INVITES_SMS: '25508574885415376', // GroupsStoreInvitesSMSMutation
	LOG_SERVER_SENT_INVITE: '26580640204871220', // LogServerSentInviteIntent
	QUERY_ONLINE_STATUS: '24599444653063564', // QueryOnlineStatusFromPDP
	QUERY_ONLINE_STATUS_LAST_SEEN: '24653084284365540' // QueryOnlineStatusLastSeenFromPDP
}

const makeGroupsSocket = config => {
	const sock = (0, chats_1.makeChatsSocket)(config)
	const { authState, ev, query, generateMessageTag, upsertMessage } = sock
	const groupQuery = async (jid, type, content) =>
		query({
			tag: 'iq',
			attrs: {
				type,
				xmlns: 'w:g2',
				to: jid
			},
			content
		})
	// Group metadata carries authoritative LID<->PN pairs for free (per-participant
	// jid + phone_number/lid attrs). Persist them so the rest of the app can resolve
	// PN<->LID without a separate usync round trip.
	const persistParticipantLidMappings = async participantLists => {
		const pairs = []
		for (const participants of participantLists) {
			for (const p of participants || []) {
				if (p.phoneNumber) pairs.push({ lid: p.id, pn: p.phoneNumber })
				else if (p.lid) pairs.push({ lid: p.lid, pn: p.id })
			}
		}
		if (!pairs.length) return
		try {
			await sock.signalRepository.lidMapping.storeLIDPNMappings(pairs)
		} catch (error) {
			sock.logger?.warn?.({ error }, 'failed to store LID/PN mappings from group metadata')
		}
	}

	const mexQuery = (variables, queryId, dataPath) =>
		(0, mex_1.executeWMexQuery)(variables, queryId, dataPath, query, generateMessageTag)
	const groupMetadata = async jid => {
		const result = await groupQuery(jid, 'get', [{ tag: 'query', attrs: { request: 'interactive' } }])
		const metadata = (0, exports.extractGroupMetadata)(result)
		persistParticipantLidMappings([metadata.participants]).catch(() => {})
		return metadata
	}
	/**
	 * Acknowledge a group. Ported from WhatsApp Web's WASmaxGroupsAcknowledgeGroupRPC
	 * (`<iq to=jid xmlns=w:g2 type=set><ack/></iq>`).
	 */
	const groupAcknowledge = async jid => {
		await groupQuery(jid, 'set', [{ tag: 'ack', attrs: {} }])
	}
	/**
	 * Get the participants of a community's linked/sub groups. Ported from
	 * WhatsApp Web's WASmaxGroupsGetLinkedGroupsParticipantsRPC.
	 * @returns {Promise<Array<{ jid: string, phoneNumber?: string }>>}
	 */
	const groupGetLinkedParticipants = async jid => {
		const result = await groupQuery(jid, 'get', [{ tag: 'linked_groups_participants', attrs: {} }])
		const node = (0, WABinary_1.getBinaryNodeChild)(result, 'linked_groups_participants')
		return (0, WABinary_1.getBinaryNodeChildren)(node, 'participant').map(p => ({
			jid: p.attrs.jid,
			phoneNumber: p.attrs.phone_number || p.attrs.pn || undefined
		}))
	}
	/**
	 * Join a community's linked/sub group (may raise a membership approval request).
	 * Ported from WhatsApp Web's WASmaxGroupsJoinLinkedGroupRPC.
	 * @param {string} parentJid community/parent group to address
	 * @param {string} linkedGroupJid linked/sub group to join
	 * @param {string} [type]
	 */
	const groupJoinLinked = async (parentJid, linkedGroupJid, type) => {
		const result = await groupQuery(parentJid, 'set', [
			{ tag: 'join_linked_group', attrs: { jid: linkedGroupJid, ...(type ? { type } : {}) } }
		])
		return { approvalRequested: !!(0, WABinary_1.getBinaryNodeChild)(result, 'membership_approval_request') }
	}
	/**
	 * Batch-fetch group profile pictures via w:g2. Ported from WhatsApp Web's
	 * WASmaxGroupsGetGroupProfilePicturesRPC. NOTE: untested against live WhatsApp —
	 * for a single group prefer profilePictureUrl().
	 * @param {string[]} jids group jids
	 * @param {'preview' | 'image'} [type]
	 */
	const getGroupProfilePictures = async (jids, type = 'preview') => {
		const result = await groupQuery(WABinary_1.S_WHATSAPP_NET, 'get', [
			{
				tag: 'pictures',
				attrs: {},
				content: jids.map(id => ({ tag: 'picture', attrs: { id, type } }))
			}
		])
		return (0, WABinary_1.getBinaryNodeChildren)(result, 'picture').map(pic => ({
			jid: pic.attrs.id || pic.attrs.jid,
			type: pic.attrs.type,
			directPath: pic.attrs['direct_path'],
			url: pic.attrs.url
		}))
	}
	/**
	 * Create a sub-group suggestion for a community. Ported from WhatsApp Web's
	 * WASmaxGroupsCreateSubGroupSuggestionRPC. The suggestion body (new vs existing
	 * groups) is caller-provided. NOTE: untested against live WhatsApp.
	 * @param {string} parentJid community/parent group to address
	 * @param {Array<{ tag: string, attrs?: object, content?: any }>} suggestion child node(s)
	 */
	const groupCreateSubGroupSuggestion = async (parentJid, suggestion) => {
		await groupQuery(parentJid, 'set', [{ tag: 'sub_group_suggestion', attrs: {}, content: suggestion }])
	}
	/**
	 * Approve, reject, or cancel sub-group suggestions for a community. Ported from
	 * WhatsApp Web's WASmaxGroupsSubGroupSuggestionsActionRPC.
	 * approve/reject address suggestions by creator jid; cancel addresses them by
	 * the suggested group's jid (WASmaxOutGroupsSubGroupSuggestionsActionRequest).
	 * @param {string} parentJid community/parent group to address
	 * @param {'approve' | 'reject' | 'cancel'} action
	 * @param {Array<{ creator?: string, jid?: string }>} suggestions
	 */
	const groupSubGroupSuggestionsAction = async (parentJid, action, suggestions) => {
		await groupQuery(parentJid, 'set', [
			{
				tag: 'sub_group_suggestions_action',
				attrs: {},
				content: [
					{
						tag: action,
						attrs: {},
						content: suggestions.map(s => ({
							tag: 'sub_group_suggestion',
							attrs: action === 'cancel' ? { jid: s.jid } : { creator: s.creator }
						}))
					}
				]
			}
		])
	}
	const groupFetchAllParticipating = async () => {
		const result = await query({
			tag: 'iq',
			attrs: {
				to: '@g.us',
				xmlns: 'w:g2',
				type: 'get'
			},
			content: [
				{
					tag: 'participating',
					attrs: {},
					content: [
						{ tag: 'participants', attrs: {} },
						{ tag: 'description', attrs: {} }
					]
				}
			]
		})
		const data = {}
		const groupsChild = (0, WABinary_1.getBinaryNodeChild)(result, 'groups')
		if (groupsChild) {
			const groups = (0, WABinary_1.getBinaryNodeChildren)(groupsChild, 'group')
			for (const groupNode of groups) {
				const meta = (0, exports.extractGroupMetadata)({
					tag: 'result',
					attrs: {},
					content: [groupNode]
				})
				data[meta.id] = meta
			}
		}
		const allGroups = Object.values(data)
		persistParticipantLidMappings(allGroups.map(g => g.participants)).catch(() => {})
		sock.ev.emit('groups.update', allGroups)
		return data
	}
	sock.ws.on('CB:ib,,dirty', async node => {
		const { attrs } = (0, WABinary_1.getBinaryNodeChild)(node, 'dirty')
		if (attrs.type !== 'groups') {
			return
		}
		await groupFetchAllParticipating()
		await sock.cleanDirtyBits('groups')
	})
	return {
		...sock,
		groupMetadata,
		groupAcknowledge,
		groupGetLinkedParticipants,
		groupJoinLinked,
		getGroupProfilePictures,
		groupCreateSubGroupSuggestion,
		groupSubGroupSuggestionsAction,
		groupCreate: async (subject, participants) => {
			const key = (0, Utils_1.generateMessageIDV2)()
			const result = await groupQuery('@g.us', 'set', [
				{
					tag: 'create',
					attrs: {
						subject,
						key
					},
					content: participants.map(jid => ({
						tag: 'participant',
						attrs: { jid }
					}))
				}
			])
			return (0, exports.extractGroupMetadata)(result)
		},
		groupLeave: async id => {
			await groupQuery('@g.us', 'set', [
				{
					tag: 'leave',
					attrs: {},
					content: [{ tag: 'group', attrs: { id } }]
				}
			])
		},
		groupUpdateSubject: async (jid, subject) => {
			await groupQuery(jid, 'set', [
				{
					tag: 'subject',
					attrs: {},
					content: Buffer.from(subject, 'utf-8')
				}
			])
		},
		groupRequestParticipantsList: async jid => {
			const result = await groupQuery(jid, 'get', [
				{
					tag: 'membership_approval_requests',
					attrs: {}
				}
			])
			const node = (0, WABinary_1.getBinaryNodeChild)(result, 'membership_approval_requests')
			const participants = (0, WABinary_1.getBinaryNodeChildren)(node, 'membership_approval_request')
			return participants.map(v => v.attrs)
		},
		groupRequestParticipantsUpdate: async (jid, participants, action) => {
			const result = await groupQuery(jid, 'set', [
				{
					tag: 'membership_requests_action',
					attrs: {},
					content: [
						{
							tag: action,
							attrs: {},
							content: participants.map(jid => ({
								tag: 'participant',
								attrs: { jid }
							}))
						}
					]
				}
			])
			const node = (0, WABinary_1.getBinaryNodeChild)(result, 'membership_requests_action')
			const nodeAction = (0, WABinary_1.getBinaryNodeChild)(node, action)
			const participantsAffected = (0, WABinary_1.getBinaryNodeChildren)(nodeAction, 'participant')
			return participantsAffected.map(p => {
				return { status: p.attrs.error || '200', jid: p.attrs.jid }
			})
		},
		groupParticipantsUpdate: async (jid, participants, action) => {
			const result = await groupQuery(jid, 'set', [
				{
					tag: action,
					attrs: {},
					content: participants.map(jid => ({
						tag: 'participant',
						attrs: { jid }
					}))
				}
			])
			const node = (0, WABinary_1.getBinaryNodeChild)(result, action)
			const participantsAffected = (0, WABinary_1.getBinaryNodeChildren)(node, 'participant')
			return participantsAffected.map(p => {
				return { status: p.attrs.error || '200', jid: p.attrs.jid, content: p }
			})
		},
		groupUpdateDescription: async (jid, description) => {
			const metadata = await groupMetadata(jid)
			const prev = metadata.descId ?? null
			await groupQuery(jid, 'set', [
				{
					tag: 'description',
					attrs: {
						...(description ? { id: (0, Utils_1.generateMessageIDV2)() } : { delete: 'true' }),
						...(prev ? { prev } : {})
					},
					content: description ? [{ tag: 'body', attrs: {}, content: Buffer.from(description, 'utf-8') }] : undefined
				}
			])
		},
		groupInviteCode: async jid => {
			const result = await groupQuery(jid, 'get', [{ tag: 'invite', attrs: {} }])
			const inviteNode = (0, WABinary_1.getBinaryNodeChild)(result, 'invite')
			return inviteNode?.attrs.code
		},
		groupRevokeInvite: async jid => {
			const result = await groupQuery(jid, 'set', [{ tag: 'invite', attrs: {} }])
			const inviteNode = (0, WABinary_1.getBinaryNodeChild)(result, 'invite')
			return inviteNode?.attrs.code
		},
		groupAcceptInvite: async code => {
			const results = await groupQuery('@g.us', 'set', [{ tag: 'invite', attrs: { code } }])
			const result = (0, WABinary_1.getBinaryNodeChild)(results, 'group')
			return result?.attrs.jid
		},
		/**
		 * revoke a v4 invite for someone
		 * @param groupJid group jid
		 * @param invitedJid jid of person you invited
		 * @returns true if successful
		 */
		groupRevokeInviteV4: async (groupJid, invitedJid) => {
			const result = await groupQuery(groupJid, 'set', [
				{ tag: 'revoke', attrs: {}, content: [{ tag: 'participant', attrs: { jid: invitedJid } }] }
			])
			return !!result
		},
		/**
		 * accept a GroupInviteMessage
		 * @param key the key of the invite message, or optionally only provide the jid of the person who sent the invite
		 * @param inviteMessage the message to accept
		 */
		groupAcceptInviteV4: ev.createBufferedFunction(async (key, inviteMessage) => {
			key = typeof key === 'string' ? { remoteJid: key } : key
			const results = await groupQuery(inviteMessage.groupJid, 'set', [
				{
					tag: 'accept',
					attrs: {
						code: inviteMessage.inviteCode,
						expiration: inviteMessage.inviteExpiration.toString(),
						admin: key.remoteJid
					}
				}
			])
			// if we have the full message key
			// update the invite message to be expired
			if (key.id) {
				// create new invite message that is expired
				inviteMessage = index_js_1.proto.Message.GroupInviteMessage.fromObject(inviteMessage)
				inviteMessage.inviteExpiration = 0
				inviteMessage.inviteCode = ''
				ev.emit('messages.update', [
					{
						key,
						update: {
							message: {
								groupInviteMessage: inviteMessage
							}
						}
					}
				])
			}
			// generate the group add message
			await upsertMessage(
				{
					key: {
						remoteJid: inviteMessage.groupJid,
						id: (0, Utils_1.generateMessageIDV2)(sock.user?.id),
						fromMe: false,
						participant: key.remoteJid
					},
					messageStubType: Types_1.WAMessageStubType.GROUP_PARTICIPANT_ADD,
					messageStubParameters: [JSON.stringify(authState.creds.me)],
					participant: key.remoteJid,
					messageTimestamp: (0, Utils_1.unixTimestampSeconds)()
				},
				'notify'
			)
			return results.attrs.from
		}),
		groupGetInviteInfo: async code => {
			const results = await groupQuery('@g.us', 'get', [{ tag: 'invite', attrs: { code } }])
			return (0, exports.extractGroupMetadata)(results)
		},
		groupToggleEphemeral: async (jid, ephemeralExpiration) => {
			const content = ephemeralExpiration
				? { tag: 'ephemeral', attrs: { expiration: ephemeralExpiration.toString() } }
				: { tag: 'not_ephemeral', attrs: {} }
			await groupQuery(jid, 'set', [content])
		},
		groupSettingUpdate: async (jid, setting) => {
			await groupQuery(jid, 'set', [{ tag: setting, attrs: {} }])
		},
		groupMemberAddMode: async (jid, mode) => {
			await groupQuery(jid, 'set', [{ tag: 'member_add_mode', attrs: {}, content: mode }])
		},
		groupJoinApprovalMode: async (jid, mode) => {
			await groupQuery(jid, 'set', [
				{ tag: 'membership_approval_mode', attrs: {}, content: [{ tag: 'group_join', attrs: { state: mode } }] }
			])
		},
		/**
		 * Get past participants of a group (left/removed members)
		 */
		groupGetPastParticipants: async jid => {
			const result = await groupQuery(jid, 'get', [{ tag: 'past_participants', attrs: {} }])
			const node = (0, WABinary_1.getBinaryNodeChild)(result, 'past_participants')
			if (!node) return []
			const participants = (0, WABinary_1.getBinaryNodeChildren)(node, 'past_participant')
			return participants.map(p => ({
				jid: p.attrs.jid,
				leaveReason: p.attrs.reason,
				leaveTimestamp: p.attrs.t ? Number(p.attrs.t) : undefined
			}))
		},
		/**
		 * Create a subgroup within a community
		 */
		groupCreateSubgroup: async (communityJid, subject, participants = []) => {
			const key = (0, Utils_1.generateMessageIDV2)()
			const result = await groupQuery('@g.us', 'set', [
				{
					tag: 'create',
					attrs: { subject, key },
					content: [
						...participants.map(jid => ({ tag: 'participant', attrs: { jid } })),
						{ tag: 'linked_parent', attrs: { jid: communityJid } }
					]
				}
			])
			return (0, exports.extractGroupMetadata)(result)
		},
		/**
		 * Link an existing group to a community
		 */
		groupLinkToCommunity: async (communityJid, groupJid) => {
			await groupQuery(communityJid, 'set', [
				{
					tag: 'links',
					attrs: {},
					content: [
						{ tag: 'link', attrs: { link_type: 'sub_group' }, content: [{ tag: 'group', attrs: { jid: groupJid } }] }
					]
				}
			])
		},
		/**
		 * Unlink a group from a community
		 */
		groupUnlinkFromCommunity: async (communityJid, groupJid) => {
			await groupQuery(communityJid, 'set', [
				{
					tag: 'unlinks',
					attrs: {},
					content: [
						{ tag: 'unlink', attrs: { link_type: 'sub_group' }, content: [{ tag: 'group', attrs: { jid: groupJid } }] }
					]
				}
			])
		},
		/**
		 * Set a member label/tag in a group
		 * @param jid group JID
		 * @param participantJid participant JID to label
		 * @param label the label string ('' to remove)
		 */
		groupSetMemberLabel: async (jid, participantJid, label) => {
			await groupQuery(jid, 'set', [
				{
					tag: 'member_add_mode',
					attrs: {},
					content: [
						{
							tag: 'participant',
							attrs: { jid: participantJid, label: label || '' }
						}
					]
				}
			])
		},
		/**
		 * Get community-linked subgroups for a community JID
		 */
		groupGetLinkedSubgroups: async communityJid => {
			const result = await groupQuery(communityJid, 'get', [{ tag: 'links', attrs: { link_type: 'sub_group' } }])
			const linksNode = (0, WABinary_1.getBinaryNodeChild)(result, 'links')
			if (!linksNode) return []
			return (0, WABinary_1.getBinaryNodeChildren)(linksNode, 'link')
				.map(link => {
					const group = (0, WABinary_1.getBinaryNodeChild)(link, 'group')
					return { jid: group?.attrs?.jid, linkType: link.attrs?.link_type }
				})
				.filter(l => !!l.jid)
		},
		groupFetchAllParticipating,

		// ── MEX queries (JSON responses) ──────────────────────────────────────

		/**
		 * Fetch group info via MEX (richer than IQ — includes invite link, LID addressing, etc.)
		 * @param {string} jid - Group JID
		 */
		groupQueryInfo: jid => mexQuery({ group_id: jid }, GROUP_MEX_QUERY_IDS.QUERY_INFO, 'xwa2_group_query_by_id'),

		/**
		 * Fetch group info by invite code via MEX.
		 * @param {string} code - Group invite code (without the link prefix)
		 */
		groupQueryInfoByCode: code =>
			mexQuery(
				{ group_input: { invite_code: code } },
				GROUP_MEX_QUERY_IDS.QUERY_INFO_BY_CODE,
				'xwa2_group_query_by_id'
			),

		/**
		 * Fetch multiple groups at once via MEX.
		 * @param {string[]} jids - Array of group JIDs
		 */
		groupQueryBatch: jids =>
			mexQuery(
				{ groups_input: jids.map(group_id => ({ group_id })) },
				GROUP_MEX_QUERY_IDS.QUERY_BATCH,
				'xwa2_group_query_batch'
			),

		/**
		 * Fetch invite link info via MEX (includes expiration, creator, etc.)
		 * @param {string} jid - Group JID
		 */
		groupQueryInviteLink: jid =>
			mexQuery({ group_input: { group_id: jid } }, GROUP_MEX_QUERY_IDS.QUERY_INVITE_LINK, 'xwa2_group_query_by_id'),

		/**
		 * Fetch all groups the current user is participating in via MEX.
		 * Returns richer data than the IQ-based groupFetchAllParticipating.
		 */
		groupQueryParticipating: () =>
			mexQuery({}, GROUP_MEX_QUERY_IDS.QUERY_PARTICIPATING, 'xwa2_group_query_participating'),

		/**
		 * Fetch suggested groups (community sub-group suggestions) via MEX.
		 * @param {string} communityJid - Community JID to get suggestions for
		 */
		groupQuerySuggested: communityJid =>
			mexQuery(
				{ group_input: { group_id: communityJid } },
				GROUP_MEX_QUERY_IDS.QUERY_SUGGESTED,
				'xwa2_group_query_by_id'
			),

		/**
		 * Fetch linked subgroup info for a community group via MEX.
		 * @param {string} jid - Group or community JID
		 */
		groupQueryLinked: jid =>
			mexQuery({ group_input: { group_id: jid } }, GROUP_MEX_QUERY_IDS.QUERY_LINKED, 'xwa2_group_query_by_id'),

		/**
		 * Fetch subgroups of a community via MEX.
		 * @param {string} communityJid - Community JID
		 */
		groupQuerySubgroups: communityJid =>
			mexQuery(
				{ group_input: { group_id: communityJid } },
				GROUP_MEX_QUERY_IDS.QUERY_SUBGROUPS,
				'xwa2_group_query_by_id'
			),

		/**
		 * Add participants to a group via MEX (V2 — supports LID, privacy metadata).
		 * Falls back to the IQ-based groupParticipantsUpdate for older servers.
		 * @param {string} jid - Group JID
		 * @param {string[]} participants - Array of JIDs to add
		 */
		groupAddParticipantsMex: (jid, participants) =>
			mexQuery(
				{ group_id: jid, participants: participants.map(p => ({ user_jid: p })) },
				GROUP_MEX_QUERY_IDS.ADD_PARTICIPANTS_V2,
				'xwa2_group_add_participants'
			),

		/**
		 * Set a group property via MEX.
		 * Known properties: member_add_mode, membership_approval_mode_enabled, member_share_group_history_mode
		 * @param {string} jid - Group JID
		 * @param {string} property - Property name
		 * @param {*} value - Property value
		 */
		groupSetProperty: (jid, property, value) =>
			mexQuery({ group_id: jid, [property]: value }, GROUP_MEX_QUERY_IDS.SET_PROPERTY, 'xwa2_group_update_property'),

		/**
		 * Reset a group's invite link via MEX (generates new code, invalidates old one).
		 * @param {string} jid - Group JID
		 */
		groupResetInviteLinkMex: jid =>
			mexQuery({ group_jid: jid }, GROUP_MEX_QUERY_IDS.RESET_INVITE_LINK, 'xwa2_group_reset_invite_link'),

		/**
		 * Create a group via MEX.
		 * Confirmed from CreateGroup mutation — input: { subject, participants: [{jid}] }
		 * @param {string} subject - Group name
		 * @param {string[]} participantJids
		 */
		groupCreateMex: (subject, participantJids) =>
			mexQuery(
				{ input: { subject, participants: participantJids.map(jid => ({ jid })) } },
				GROUP_MEX_QUERY_IDS.CREATE_GROUP,
				'xwa2_group_create'
			),

		/**
		 * Allow non-admin community members to create subgroups.
		 * @param {string} communityJid - Community JID
		 * @param {boolean} allow
		 */
		groupAllowNonAdminCreation: (communityJid, allow) =>
			mexQuery(
				{ group_jid: communityJid, allow_non_admin_sub_group_creation: allow },
				GROUP_MEX_QUERY_IDS.ALLOW_NON_ADMIN_GROUP_CREATION,
				'xwa2_group_allow_non_admin_creation'
			),

		/**
		 * Get info about a group invite link (before joining).
		 * @param {string} inviteCode - The raw invite code (not full URL)
		 */
		groupGetInviteInfo: inviteCode =>
			mexQuery({ invite_code: inviteCode }, GROUP_MEX_QUERY_IDS.GET_INVITE_INFO, 'xwa2_group_get_invite_info'),

		/**
		 * Fetch pending add requests for pre-registration group invites.
		 * @param {string} jid - Group JID
		 */
		groupPreRegAddRequests: jid =>
			mexQuery({ group_jid: jid }, GROUP_MEX_QUERY_IDS.GET_PRE_REG_ADD_REQUESTS, 'xwa2_group_pre_reg_add_requests'),

		/**
		 * Get suggested contacts to add to a group.
		 * @param {string} jid - Group JID
		 */
		groupSuggestedContacts: jid =>
			mexQuery({ group_jid: jid }, GROUP_MEX_QUERY_IDS.GET_SUGGESTED_CONTACTS, 'xwa2_group_suggested_contacts'),

		/**
		 * Store SMS invite links for a group.
		 * @param {string} jid - Group JID
		 * @param {{ phone: string, inviteCode: string }[]} invites
		 */
		groupStoreInvitesSms: (jid, invites) =>
			mexQuery(
				{ group_jid: jid, invites: invites.map(({ phone, inviteCode }) => ({ phone, invite_code: inviteCode })) },
				GROUP_MEX_QUERY_IDS.STORE_INVITES_SMS,
				'xwa2_group_store_invites_sms'
			),

		/**
		 * Log a server-sent invite intent (analytics).
		 * @param {string} jid - Group JID
		 * @param {string} inviteCode
		 */
		groupLogServerSentInvite: (jid, inviteCode) =>
			mexQuery(
				{ group_jid: jid, invite_code: inviteCode },
				GROUP_MEX_QUERY_IDS.LOG_SERVER_SENT_INVITE,
				'xwa2_group_log_server_sent_invite'
			),

		/**
		 * Query online status of users from PDP.
		 * @param {string[]} jids - User JIDs
		 */
		queryOnlineStatus: jids => mexQuery({ jids }, GROUP_MEX_QUERY_IDS.QUERY_ONLINE_STATUS, 'xwa2_query_online_status'),

		/**
		 * Query online status and last seen of users from PDP.
		 * @param {string[]} jids - User JIDs
		 */
		queryOnlineStatusLastSeen: jids =>
			mexQuery({ jids }, GROUP_MEX_QUERY_IDS.QUERY_ONLINE_STATUS_LAST_SEEN, 'xwa2_query_online_status_last_seen'),

		GROUP_MEX_QUERY_IDS
	}
}
exports.makeGroupsSocket = makeGroupsSocket
const extractGroupMetadata = result => {
	const group = (0, WABinary_1.getBinaryNodeChild)(result, 'group')
	const descChild = (0, WABinary_1.getBinaryNodeChild)(group, 'description')
	let desc
	let descId
	let descOwner
	let descOwnerPn
	let descOwnerUsername
	let descTime
	if (descChild) {
		desc = (0, WABinary_1.getBinaryNodeChildString)(descChild, 'body')
		descOwner = descChild.attrs.participant ? (0, WABinary_1.jidNormalizedUser)(descChild.attrs.participant) : undefined
		descOwnerPn = descChild.attrs.participant_pn
			? (0, WABinary_1.jidNormalizedUser)(descChild.attrs.participant_pn)
			: undefined
		descOwnerUsername = descChild.attrs.participant_username || undefined
		descTime = +descChild.attrs.t
		descId = descChild.attrs.id
	}
	const groupId = group.attrs.id.includes('@') ? group.attrs.id : (0, WABinary_1.jidEncode)(group.attrs.id, 'g.us')
	const eph = (0, WABinary_1.getBinaryNodeChild)(group, 'ephemeral')?.attrs.expiration
	const memberAddMode = (0, WABinary_1.getBinaryNodeChildString)(group, 'member_add_mode') === 'all_member_add'
	const linkedParentNode = (0, WABinary_1.getBinaryNodeChild)(group, 'linked_parent')
	const communityMemberAddGroupNode = (0, WABinary_1.getBinaryNodeChild)(group, 'allow_non_admin_sub_group_creation')
	const subGroupVisibilityNode = (0, WABinary_1.getBinaryNodeChild)(group, 'sub_groups_list')
	const membershipApprovalNode = (0, WABinary_1.getBinaryNodeChild)(group, 'membership_approval_mode')
	const capiNode = (0, WABinary_1.getBinaryNodeChild)(group, 'capi')
	const appealStatusNode = (0, WABinary_1.getBinaryNodeChild)(group, 'appeal_status')
	const defaultSubGroupNode = (0, WABinary_1.getBinaryNodeChild)(group, 'default_sub_group')
	const generalChatNode = (0, WABinary_1.getBinaryNodeChild)(group, 'general_chat')
	const hiddenGroupNode = (0, WABinary_1.getBinaryNodeChild)(group, 'hidden_group')
	const metadata = {
		id: groupId,
		notify: group.attrs.notify,
		addressingMode:
			group.attrs.addressing_mode === 'lid' ? Types_1.WAMessageAddressingMode.LID : Types_1.WAMessageAddressingMode.PN,
		subject: group.attrs.subject,
		subjectOwner: group.attrs.s_o,
		subjectOwnerPn: group.attrs.s_o_pn,
		subjectOwnerUsername: group.attrs.s_o_username,
		subjectTime: +group.attrs.s_t,
		size: group.attrs.size ? +group.attrs.size : (0, WABinary_1.getBinaryNodeChildren)(group, 'participant').length,
		creation: +group.attrs.creation,
		owner: group.attrs.creator ? (0, WABinary_1.jidNormalizedUser)(group.attrs.creator) : undefined,
		ownerPn: group.attrs.creator_pn ? (0, WABinary_1.jidNormalizedUser)(group.attrs.creator_pn) : undefined,
		ownerUsername: group.attrs.creator_username || undefined,
		owner_country_code: group.attrs.creator_country_code,
		desc,
		descId,
		descOwner,
		descOwnerPn,
		descOwnerUsername,
		descTime,
		linkedParent: linkedParentNode?.attrs.jid || undefined,
		restrict: !!(0, WABinary_1.getBinaryNodeChild)(group, 'locked'),
		announce: !!(0, WABinary_1.getBinaryNodeChild)(group, 'announcement'),
		isCommunity: !!(0, WABinary_1.getBinaryNodeChild)(group, 'parent'),
		isCommunityAnnounce: !!(0, WABinary_1.getBinaryNodeChild)(group, 'default_sub_group'),
		joinApprovalMode: !!membershipApprovalNode,
		memberAddMode,
		memberShareHistoryMode:
			(0, WABinary_1.getBinaryNodeChildString)(group, 'member_share_group_history_mode') || undefined,
		memberLinkMode: (0, WABinary_1.getBinaryNodeChildString)(group, 'member_link_mode') || undefined,
		limitSharing: !!(0, WABinary_1.getBinaryNodeChild)(group, 'limit_sharing_enabled'),
		communityMemberAddGroupMode: communityMemberAddGroupNode?.attrs.state || undefined,
		capiCreatedGroup: !!capiNode || undefined,
		appealStatus: appealStatusNode?.attrs.type || undefined,
		isSubGroupHidden: group.attrs.sub_group_visibility === 'hidden' || undefined,
		membershipApprovalMode: group.attrs.membership_approval_mode || undefined,
		joinPermissions: group.attrs.join_permissions || undefined,
		isDefaultSubgroup: !!defaultSubGroupNode || undefined,
		isGeneralSubgroup: !!generalChatNode || undefined,
		isHiddenSubgroup: !!hiddenGroupNode || undefined,
		participants: (0, WABinary_1.getBinaryNodeChildren)(group, 'participant').map(({ attrs }) => {
			// extractGroupMetadata is sync and has no socket in scope to persist with;
			// callers (groupMetadata, groupFetchAllParticipating) persist the LID/PN
			// pairs surfaced here via persistParticipantLidMappings.
			return {
				id: attrs.jid,
				phoneNumber:
					(0, WABinary_1.isLidUser)(attrs.jid) && (0, WABinary_1.isPnUser)(attrs.phone_number)
						? attrs.phone_number
						: undefined,
				lid: (0, WABinary_1.isPnUser)(attrs.jid) && (0, WABinary_1.isLidUser)(attrs.lid) ? attrs.lid : undefined,
				username: attrs.participant_username || attrs.username || undefined,
				admin: attrs.type || null,
				memberLabel: attrs.label || undefined,
				memberLabelTimestamp: attrs.label_ts ? +attrs.label_ts : undefined,
				isBanned: attrs.error === '402' || attrs.ban === 'true' || undefined,
				uuid: attrs.uuid || attrs.participant_uuid || undefined
			}
		}),
		bannedParticipants: (0, WABinary_1.getBinaryNodeChildren)(group, 'participant')
			.filter(({ attrs }) => attrs.error === '402' || attrs.ban === 'true')
			.map(({ attrs }) => ({
				id: attrs.jid,
				phoneNumber: attrs.phone_number || undefined,
				lid: attrs.lid || undefined
			})),
		ephemeralDuration: eph ? +eph : undefined
	}
	return metadata
}
exports.extractGroupMetadata = extractGroupMetadata
