'use strict'
var __importDefault =
	(this && this.__importDefault) ||
	function (mod) {
		return mod && mod.__esModule ? mod : { default: mod }
	}
Object.defineProperty(exports, '__esModule', { value: true })
exports.extractCommunityMetadata = exports.makeCommunitiesSocket = void 0
const index_js_1 = require('../../WAProto/index.js')
const Types_1 = require('../Types')
const Utils_1 = require('../Utils')
const logger_1 = __importDefault(require('../Utils/logger'))
const WABinary_1 = require('../WABinary')
const business_1 = require('./business')
const makeCommunitiesSocket = config => {
	const sock = (0, business_1.makeBusinessSocket)(config)
	const { authState, ev, query, upsertMessage } = sock
	const communityQuery = async (jid, type, content) =>
		query({
			tag: 'iq',
			attrs: {
				type,
				xmlns: 'w:g2',
				to: jid
			},
			content
		})
	const communityMetadata = async jid => {
		const result = await communityQuery(jid, 'get', [{ tag: 'query', attrs: { request: 'interactive' } }])
		return (0, exports.extractCommunityMetadata)(result)
	}
	const communityFetchAllParticipating = async () => {
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
		const communitiesChild = (0, WABinary_1.getBinaryNodeChild)(result, 'communities')
		if (communitiesChild) {
			const communities = (0, WABinary_1.getBinaryNodeChildren)(communitiesChild, 'community')
			for (const communityNode of communities) {
				const meta = (0, exports.extractCommunityMetadata)({
					tag: 'result',
					attrs: {},
					content: [communityNode]
				})
				data[meta.id] = meta
			}
		}
		sock.ev.emit('groups.update', Object.values(data))
		return data
	}
	async function parseGroupResult(node) {
		logger_1.default.info({ node }, 'parseGroupResult')
		const groupNode = (0, WABinary_1.getBinaryNodeChild)(node, 'group')
		if (groupNode) {
			try {
				const metadata = await sock.groupMetadata(`${groupNode.attrs.id}@g.us`)
				return metadata ? metadata : Optional.empty()
			} catch (error) {
				logger_1.default.error({ error }, 'Error fetching community group metadata')
				return Optional.empty()
			}
		}
		return Optional.empty()
	}
	const Optional = {
		empty: () => null,
		of: value => (value !== null ? { value } : null)
	}
	sock.ws.on('CB:ib,,dirty', async node => {
		const { attrs } = (0, WABinary_1.getBinaryNodeChild)(node, 'dirty')
		if (attrs.type !== 'communities') {
			return
		}
		await communityFetchAllParticipating()
		await sock.cleanDirtyBits('groups')
	})
	return {
		...sock,
		communityMetadata,
		communityCreate: async (subject, body) => {
			const descriptionId = (0, Utils_1.generateMessageID)().substring(0, 12)
			const result = await communityQuery('@g.us', 'set', [
				{
					tag: 'create',
					attrs: { subject },
					content: [
						{
							tag: 'description',
							attrs: { id: descriptionId },
							content: [
								{
									tag: 'body',
									attrs: {},
									content: Buffer.from(body || '', 'utf-8')
								}
							]
						},
						{
							tag: 'parent',
							attrs: { default_membership_approval_mode: 'request_required' }
						},
						{
							tag: 'allow_non_admin_sub_group_creation',
							attrs: {}
						},
						{
							tag: 'create_general_chat',
							attrs: {}
						}
					]
				}
			])
			return await parseGroupResult(result)
		},
		communityCreateGroup: async (subject, participants, parentCommunityJid) => {
			const key = (0, Utils_1.generateMessageIDV2)()
			const result = await communityQuery('@g.us', 'set', [
				{
					tag: 'create',
					attrs: {
						subject,
						key
					},
					content: [
						...participants.map(jid => ({
							tag: 'participant',
							attrs: { jid }
						})),
						{ tag: 'linked_parent', attrs: { jid: parentCommunityJid } }
					]
				}
			])
			return await parseGroupResult(result)
		},
		communityLeave: async id => {
			await communityQuery('@g.us', 'set', [
				{
					tag: 'leave',
					attrs: {},
					content: [{ tag: 'community', attrs: { id } }]
				}
			])
		},
		communityUpdateSubject: async (jid, subject) => {
			await communityQuery(jid, 'set', [
				{
					tag: 'subject',
					attrs: {},
					content: Buffer.from(subject, 'utf-8')
				}
			])
		},
		communityLinkGroup: async (groupJid, parentCommunityJid) => {
			await communityQuery(parentCommunityJid, 'set', [
				{
					tag: 'links',
					attrs: {},
					content: [
						{
							tag: 'link',
							attrs: { link_type: 'sub_group' },
							content: [{ tag: 'group', attrs: { jid: groupJid } }]
						}
					]
				}
			])
		},
		communityUnlinkGroup: async (groupJid, parentCommunityJid) => {
			await communityQuery(parentCommunityJid, 'set', [
				{
					tag: 'unlink',
					attrs: { unlink_type: 'sub_group' },
					content: [{ tag: 'group', attrs: { jid: groupJid } }]
				}
			])
		},
		communityFetchLinkedGroups: async jid => {
			let communityJid = jid
			let isCommunity = false
			// Try to determine if it is a subgroup or a community
			const metadata = await sock.groupMetadata(jid)
			if (metadata.linkedParent) {
				// It is a subgroup, get the community jid
				communityJid = metadata.linkedParent
			} else {
				// It is a community
				isCommunity = true
			}
			// Fetch all subgroups of the community
			const result = await communityQuery(communityJid, 'get', [{ tag: 'sub_groups', attrs: {} }])
			const linkedGroupsData = []
			const subGroupsNode = (0, WABinary_1.getBinaryNodeChild)(result, 'sub_groups')
			if (subGroupsNode) {
				const groupNodes = (0, WABinary_1.getBinaryNodeChildren)(subGroupsNode, 'group')
				for (const groupNode of groupNodes) {
					linkedGroupsData.push({
						id: groupNode.attrs.id ? (0, WABinary_1.jidEncode)(groupNode.attrs.id, 'g.us') : undefined,
						subject: groupNode.attrs.subject || '',
						creation: groupNode.attrs.creation ? Number(groupNode.attrs.creation) : undefined,
						owner: groupNode.attrs.creator ? (0, WABinary_1.jidNormalizedUser)(groupNode.attrs.creator) : undefined,
						size: groupNode.attrs.size ? Number(groupNode.attrs.size) : undefined
					})
				}
			}
			return {
				communityJid,
				isCommunity,
				linkedGroups: linkedGroupsData
			}
		},
		communityRequestParticipantsList: async jid => {
			const result = await communityQuery(jid, 'get', [
				{
					tag: 'membership_approval_requests',
					attrs: {}
				}
			])
			const node = (0, WABinary_1.getBinaryNodeChild)(result, 'membership_approval_requests')
			const participants = (0, WABinary_1.getBinaryNodeChildren)(node, 'membership_approval_request')
			return participants.map(v => v.attrs)
		},
		communityRequestParticipantsUpdate: async (jid, participants, action) => {
			const result = await communityQuery(jid, 'set', [
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
		communityParticipantsUpdate: async (jid, participants, action) => {
			const result = await communityQuery(jid, 'set', [
				{
					tag: action,
					attrs: action === 'remove' ? { linked_groups: 'true' } : {},
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
		communityUpdateDescription: async (jid, description) => {
			const metadata = await communityMetadata(jid)
			const prev = metadata.descId ?? null
			await communityQuery(jid, 'set', [
				{
					tag: 'description',
					attrs: {
						...(description ? { id: (0, Utils_1.generateMessageID)() } : { delete: 'true' }),
						...(prev ? { prev } : {})
					},
					content: description ? [{ tag: 'body', attrs: {}, content: Buffer.from(description, 'utf-8') }] : undefined
				}
			])
		},
		communityInviteCode: async jid => {
			const result = await communityQuery(jid, 'get', [{ tag: 'invite', attrs: {} }])
			const inviteNode = (0, WABinary_1.getBinaryNodeChild)(result, 'invite')
			return inviteNode?.attrs.code
		},
		communityRevokeInvite: async jid => {
			const result = await communityQuery(jid, 'set', [{ tag: 'invite', attrs: {} }])
			const inviteNode = (0, WABinary_1.getBinaryNodeChild)(result, 'invite')
			return inviteNode?.attrs.code
		},
		communityAcceptInvite: async code => {
			const results = await communityQuery('@g.us', 'set', [{ tag: 'invite', attrs: { code } }])
			const result = (0, WABinary_1.getBinaryNodeChild)(results, 'community')
			return result?.attrs.jid
		},
		/**
		 * revoke a v4 invite for someone
		 * @param communityJid community jid
		 * @param invitedJid jid of person you invited
		 * @returns true if successful
		 */
		communityRevokeInviteV4: async (communityJid, invitedJid) => {
			const result = await communityQuery(communityJid, 'set', [
				{ tag: 'revoke', attrs: {}, content: [{ tag: 'participant', attrs: { jid: invitedJid } }] }
			])
			return !!result
		},
		/**
		 * accept a CommunityInviteMessage
		 * @param key the key of the invite message, or optionally only provide the jid of the person who sent the invite
		 * @param inviteMessage the message to accept
		 */
		communityAcceptInviteV4: ev.createBufferedFunction(async (key, inviteMessage) => {
			key = typeof key === 'string' ? { remoteJid: key } : key
			const results = await communityQuery(inviteMessage.groupJid, 'set', [
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
			// generate the community add message
			await upsertMessage(
				{
					key: {
						remoteJid: inviteMessage.groupJid,
						id: (0, Utils_1.generateMessageIDV2)(sock.user?.id),
						fromMe: false,
						participant: key.remoteJid // TODO: investigate if this makes any sense at all
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
		communityGetInviteInfo: async code => {
			const results = await communityQuery('@g.us', 'get', [{ tag: 'invite', attrs: { code } }])
			return (0, exports.extractCommunityMetadata)(results)
		},
		communityToggleEphemeral: async (jid, ephemeralExpiration) => {
			const content = ephemeralExpiration
				? { tag: 'ephemeral', attrs: { expiration: ephemeralExpiration.toString() } }
				: { tag: 'not_ephemeral', attrs: {} }
			await communityQuery(jid, 'set', [content])
		},
		communitySettingUpdate: async (jid, setting) => {
			await communityQuery(jid, 'set', [{ tag: setting, attrs: {} }])
		},
		communityMemberAddMode: async (jid, mode) => {
			await communityQuery(jid, 'set', [{ tag: 'member_add_mode', attrs: {}, content: mode }])
		},
		communityJoinApprovalMode: async (jid, mode) => {
			await communityQuery(jid, 'set', [
				{ tag: 'membership_approval_mode', attrs: {}, content: [{ tag: 'community_join', attrs: { state: mode } }] }
			])
		},
		/**
		 * Update community profile picture
		 */
		communityUpdatePicture: async (jid, content) => {
			const { img } = await (0, Utils_1.generateProfilePicture)(content)
			await communityQuery(jid, 'set', [
				{
					tag: 'picture',
					attrs: { type: 'image' },
					content: img
				}
			])
		},
		/**
		 * Remove community profile picture
		 */
		communityRemovePicture: async jid => {
			await communityQuery(jid, 'set', [{ tag: 'picture', attrs: { type: 'delete' } }])
		},
		/**
		 * Update community settings (announce-only, etc.)
		 */
		communitySettingUpdate: async (jid, setting) => {
			await communityQuery(jid, 'set', [{ tag: setting, attrs: {} }])
		},
		/**
		 * Deactivate/delete a community
		 */
		communityDeactivate: async jid => {
			await communityQuery(jid, 'set', [{ tag: 'delete', attrs: {} }])
		},
		/**
		 * Get info about a community from an invite link code
		 */
		communityGetInviteInfo: async code => {
			const results = await communityQuery('@g.us', 'get', [{ tag: 'invite', attrs: { code } }])
			return (0, exports.extractCommunityMetadata)(results)
		},
		/**
		 * Toggle ephemeral messages for the whole community
		 */
		communityToggleEphemeral: async (jid, ephemeralExpiration) => {
			const content = ephemeralExpiration
				? { tag: 'ephemeral', attrs: { expiration: ephemeralExpiration.toString() } }
				: { tag: 'not_ephemeral', attrs: {} }
			await communityQuery(jid, 'set', [content])
		},
		communityFetchAllParticipating
	}
}
exports.makeCommunitiesSocket = makeCommunitiesSocket
const extractCommunityMetadata = result => {
	const community = (0, WABinary_1.getBinaryNodeChild)(result, 'community')
	const descChild = (0, WABinary_1.getBinaryNodeChild)(community, 'description')
	let desc
	let descId
	if (descChild) {
		desc = (0, WABinary_1.getBinaryNodeChildString)(descChild, 'body')
		descId = descChild.attrs.id
	}
	const communityId = community.attrs.id?.includes('@')
		? community.attrs.id
		: (0, WABinary_1.jidEncode)(community.attrs.id || '', 'g.us')
	const eph = (0, WABinary_1.getBinaryNodeChild)(community, 'ephemeral')?.attrs.expiration
	const memberAddMode = (0, WABinary_1.getBinaryNodeChildString)(community, 'member_add_mode') === 'all_member_add'
	const metadata = {
		id: communityId,
		subject: community.attrs.subject || '',
		subjectOwner: community.attrs.s_o,
		subjectTime: Number(community.attrs.s_t || 0),
		size: (0, WABinary_1.getBinaryNodeChildren)(community, 'participant').length,
		creation: Number(community.attrs.creation || 0),
		owner: community.attrs.creator ? (0, WABinary_1.jidNormalizedUser)(community.attrs.creator) : undefined,
		desc,
		descId,
		linkedParent: (0, WABinary_1.getBinaryNodeChild)(community, 'linked_parent')?.attrs.jid || undefined,
		restrict: !!(0, WABinary_1.getBinaryNodeChild)(community, 'locked'),
		announce: !!(0, WABinary_1.getBinaryNodeChild)(community, 'announcement'),
		isCommunity: !!(0, WABinary_1.getBinaryNodeChild)(community, 'parent'),
		isCommunityAnnounce: !!(0, WABinary_1.getBinaryNodeChild)(community, 'default_sub_community'),
		joinApprovalMode: !!(0, WABinary_1.getBinaryNodeChild)(community, 'membership_approval_mode'),
		memberAddMode,
		participants: (0, WABinary_1.getBinaryNodeChildren)(community, 'participant').map(({ attrs }) => {
			return {
				// TODO: IMPLEMENT THE PN/LID FIELDS HERE!!
				id: attrs.jid,
				admin: attrs.type || null
			}
		}),
		ephemeralDuration: eph ? +eph : undefined,
		addressingMode: (0, WABinary_1.getBinaryNodeChildString)(community, 'addressing_mode')
	}
	return metadata
}
exports.extractCommunityMetadata = extractCommunityMetadata
