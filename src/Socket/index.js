'use strict'
Object.defineProperty(exports, '__esModule', { value: true })
const Defaults_1 = require('../Defaults')
const communities_1 = require('./communities')
const { makeInteropSocket } = require('./interop')
const { makePrivacySocket } = require('./privacy')
const { makeRegistrationSocket } = require('./registration')
const { makeManagedAccountSocket } = require('./managed-account')
const { makeGraphQLSocket } = require('./graphql')
const { makeVoipSocket } = require('./voip-socket')
// Antiban protection — bundled directly into baron-baileys-v2
const { wrapSocket: _wrapSocket } = require('../antiban')

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
	const graphqlSock = makeGraphQLSocket(managedSock)
	const voipSock = makeVoipSocket(graphqlSock)
	// Auto-wrap with antiban if available (config.antiban = false to opt-out)
	if (_wrapSocket && config?.antiban !== false) {
		const antibanConfig = config?.antiban || 'aggressive'
		return _wrapSocket(voipSock, antibanConfig)
	}
	return voipSock
}
exports.default = makeWASocket
