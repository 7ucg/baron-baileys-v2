'use strict'
Object.defineProperty(exports, '__esModule', { value: true })
exports.waitForBackoff = exports.setProtocolBackoffMs = void 0

// Per-protocol backoff state, ported from WhatsApp Web's WAWebUsyncBackoff.
// A server-reported error on a usync protocol (e.g. "devices") can carry a
// backoff (seconds); subsequent usync queries touching that protocol should
// wait it out before firing, except time-critical device lookups made while
// sending a message or placing a call.
const backoffPromises = new Map()

const setProtocolBackoffMs = (protocolName, ms) => {
	backoffPromises.set(protocolName, new Promise(resolve => setTimeout(resolve, ms)))
}
exports.setProtocolBackoffMs = setProtocolBackoffMs

const shouldWaitForBackoff = query => {
	if (query.context === 'interactive') {
		return false
	}
	const protocolNames = query.protocols.map(p => p.name)
	return !(protocolNames.includes('devices') && (query.context === 'message' || query.context === 'voip'))
}

const waitForBackoff = async query => {
	if (!shouldWaitForBackoff(query)) {
		return
	}
	await Promise.all(query.protocols.map(p => backoffPromises.get(p.name)))
}
exports.waitForBackoff = waitForBackoff
