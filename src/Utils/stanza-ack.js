'use strict'
Object.defineProperty(exports, '__esModule', { value: true })
exports.buildAckStanza = buildAckStanza
// Standalone call stanzas use class="call" + type=<tag>, not class=<tag>.
// Kept in sync with messages-recv.js's CALL_STATE_TAGS + CB: registration loop.
const CALL_STANZA_TAGS = new Set([
	'offer',
	'offer_notice',
	'terminate',
	'accept',
	'reject',
	'preaccept',
	'transport',
	'video',
	'duration',
	'mute_v2',
	'lobby',
	'heartbeat',
	'relaylatency',
	'link_query',
	'group_update',
	'accept_ack',
	'enc-rekey',
	'enc_rekey',
	'peer_state',
	'group_info',
	'video_state',
	'video_state_ack',
	'flow_control',
	'waiting_room_request'
])
/**
 * Builds an ACK stanza for a received node.
 * Pure function -- no I/O, no side effects.
 *
 * Mirrors WhatsApp Web's ACK construction:
 * - WAWebHandleMsgSendAck.sendAck / sendNack
 * - WAWebCreateNackFromStanza.createNackFromStanza
 */
function buildAckStanza(node, errorCode, meId) {
	const { tag, attrs } = node
	const isCallStanza = CALL_STANZA_TAGS.has(tag)
	const stanza = {
		tag: 'ack',
		attrs: {
			id: attrs.id,
			to: attrs.from,
			class: isCallStanza ? 'call' : tag
		}
	}
	// For standalone call stanzas, WA Web puts the original tag into `type`
	if (isCallStanza) {
		stanza.attrs.type = tag
	}
	if (errorCode) {
		stanza.attrs.error = errorCode.toString()
	}
	if (attrs.participant) {
		stanza.attrs.participant = attrs.participant
	}
	if (attrs.recipient) {
		stanza.attrs.recipient = attrs.recipient
	}
	// WA Web always includes type when present: `n.type || DROP_ATTR`
	// For call stanzas the type is already set to the tag name above; don't override it.
	if (attrs.type && !isCallStanza) {
		stanza.attrs.type = attrs.type
	}
	// WA Web WAWebHandleMsgSendAck.sendAck/sendNack always include `from` for message-class ACKs
	if (tag === 'message' && meId) {
		stanza.attrs.from = meId
	}
	return stanza
}
