'use strict'
Object.defineProperty(exports, '__esModule', { value: true })
exports.emitSyncActionResults = exports.processContactAction = void 0
const WABinary_1 = require('../WABinary')
/**
 * Process contactAction and return events to emit.
 * Pure function - no side effects.
 */
const processContactAction = (action, id, logger) => {
	const results = []
	if (!id) {
		logger?.warn(
			{ hasFullName: !!action.fullName, hasLidJid: !!action.lidJid, hasPnJid: !!action.pnJid },
			'contactAction sync: missing id in index'
		)
		return results
	}
	const lidJid = action.lidJid
	const idIsPn = (0, WABinary_1.isPnUser)(id)
	// PN is in index[1], not in contactAction.pnJid which is usually null
	const phoneNumber = idIsPn ? id : action.pnJid || undefined
	// Always emit contacts.upsert
	results.push({
		event: 'contacts.upsert',
		data: [
			{
				id,
				name: action.fullName || action.firstName || action.username || undefined,
				username: action.username || undefined,
				lid: lidJid || undefined,
				phoneNumber,
				birthday: action.birthday || undefined
			}
		]
	})
	// Emit lid-mapping.update if we have valid LID-PN pair
	if (lidJid && (0, WABinary_1.isLidUser)(lidJid) && idIsPn) {
		results.push({
			event: 'lid-mapping.update',
			data: { lid: lidJid, pn: id }
		})
	}
	return results
}
exports.processContactAction = processContactAction
const emitSyncActionResults = (ev, results) => {
	for (const result of results) {
		if (result.event === 'contacts.upsert') {
			ev.emit('contacts.upsert', result.data)
		} else {
			ev.emit('lid-mapping.update', result.data)
		}
	}
}
exports.emitSyncActionResults = emitSyncActionResults
