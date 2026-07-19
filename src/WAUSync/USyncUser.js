'use strict'
Object.defineProperty(exports, '__esModule', { value: true })
exports.USyncUser = void 0
class USyncUser {
	withId(id) {
		this.id = id
		return this
	}
	withLid(lid) {
		this.lid = lid
		return this
	}
	withPhone(phone) {
		this.phone = phone
		return this
	}
	withUsername(username) {
		this.username = username
		return this
	}
	withUsernameKey(usernameKey) {
		this.usernameKey = usernameKey
		return this
	}
	withType(type) {
		this.type = type
		return this
	}
	withPersonaId(personaId) {
		this.personaId = personaId
		return this
	}
	withTcToken(tcToken) {
		this.tcToken = tcToken
		return this
	}
	withPnJid(pnJid) {
		this.pnJid = pnJid
		return this
	}
	withDeviceHash(deviceHash) {
		this.deviceHash = deviceHash
		return this
	}
	withTs(ts) {
		this.ts = ts
		return this
	}
	withExpectedTs(expectedTs) {
		this.expectedTs = expectedTs
		return this
	}
	/** Ported from WAWebUsyncUser's validate() — a usync user needs at least one addressable field. */
	validate() {
		return !!(this.id || this.phone || this.username || this.pnJid)
	}
}
exports.USyncUser = USyncUser
