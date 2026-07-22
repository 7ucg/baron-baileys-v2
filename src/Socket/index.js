'use strict'
Object.defineProperty(exports, '__esModule', { value: true })
const Defaults_1 = require('../Defaults')
const communities_1 = require('./communities')
const { makeInteropSocket } = require('./interop')
const { makePrivacySocket } = require('./privacy')
const { makeRegistrationSocket } = require('./registration')
const { makeManagedAccountSocket } = require('./managed-account')
const { makeGraphQLSocket } = require('./graphql')
// Antiban protection — bundled directly into baron-baileys-v2
const { wrapSocket: _wrapSocket } = require('../antiban')

// VoIP socket wrapper (ESM module)
let makeVoipSocket = null
const loadVoipSocket = async () => {
	if (!makeVoipSocket) {
		try {
			const voipModule = await import('./voip-socket.mjs')
			makeVoipSocket = voipModule.makeVoipSocket
		} catch (err) {
			console.error('Failed to load VoIP module:', err.message)
			return null
		}
	}
	return makeVoipSocket
}

// export the last socket layer
const makeWASocket = config => {
	const userExplicitSyncFlag = typeof config?.syncFullHistory === 'boolean'
	const initialFullSyncDone = !!config?.auth?.creds?.initialFullSyncDone
	const effectiveSyncFullHistory = userExplicitSyncFlag ? config.syncFullHistory : !initialFullSyncDone
	const newConfig = {
		...Defaults_1.DEFAULT_CONNECTION_CONFIG,
		...config,
		syncFullHistory: effectiveSyncFullHistory
	}
	newConfig.logger?.debug?.(
		{ initialFullSyncDone, effectiveSyncFullHistory, userExplicitSyncFlag },
		'computed syncFullHistory policy'
	)
	const baseSock = (0, communities_1.makeCommunitiesSocket)(newConfig)
	const interopSock = makeInteropSocket(baseSock)
	const privacySock = makePrivacySocket(interopSock)
	const registrationSock = makeRegistrationSocket(privacySock)
	const managedSock = makeManagedAccountSocket(registrationSock)
	const sock = makeGraphQLSocket(managedSock)

	// Add VoIP initialization method to socket
	sock.initVoip = async function () {
		const voipFn = await loadVoipSocket()
		if (voipFn) {
			voipFn(sock) // Attach voip to socket
			return sock.voip // Return the voip object
		}
		throw new Error('VoIP module failed to load')
	}

	// Auto-wrap with antiban if available (config.antiban = false to opt-out)
	if (_wrapSocket && config?.antiban !== false) {
		const antibanConfig = config?.antiban || 'aggressive'
		return _wrapSocket(sock, antibanConfig)
	}
	return sock
}
exports.default = makeWASocket
