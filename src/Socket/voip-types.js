'use strict'

/**
 * Shared type definitions for baileys-caller VoIP.
 * These are mostly documentation via JSDoc; at runtime they're optional.
 * @author ShellTear
 */

/**
 * Audio stream configuration reported by the WASM.
 * @typedef {Object} AudioConfig
 * @property {number} sampleRate
 * @property {number} channels
 * @property {number} bitsPerSample
 * @property {number} framesPerChunk
 */

/**
 * Options for placing a call.
 * @typedef {Object} CallOptions
 * @property {string} to - Phone number, digits only (e.g. "12345678901")
 * @property {string} [audioSource] - Audio source: file path to MP3/WAV, or "silence" for empty uplink
 * @property {number} [durationMs] - Auto-hangup after N ms (default: 120000)
 */

/**
 * Events emitted by an ActiveCall.
 * @typedef {Object} CallEvents
 * @property {Function} ringing
 * @property {Function} connected
 * @property {Function} audio - 16 kHz mono Float32 PCM frame from the remote peer
 * @property {Function} ended - Reason: "hangup" | "timeout" | "rejected" | "remote_end" | "disconnect" | etc.
 * @property {Function} error
 */

/**
 * Top-level SDK configuration.
 * @typedef {Object} VoipSdkConfig
 * @property {string} authDir - Path to a Baileys multi-file auth state directory
 */

/**
 * Relay list update payload from WASM call event 156.
 * @typedef {Object} RelayListUpdate
 * @property {string} relay_key
 * @property {string[]} relay_tokens
 * @property {string[]} [auth_tokens]
 * @property {boolean} [enable_edgeray_dtls_active_mode]
 * @property {Array<{relay_id: number, relay_name: string, token_id: number, auth_token_id?: number, addresses: Array}>} relays
 */

/**
 * Mirrors the WhatsApp WASM CallState enum.
 */
const CallState = {
	Idle: 0,
	Calling: 1,
	PreacceptReceived: 2,
	ReceivedCall: 3,
	AcceptSent: 4,
	AcceptReceived: 5,
	Active: 6,
	ActiveElsewhere: 7,
	Ending: 13
}

/**
 * WASM Audio configuration types
 * @typedef {Object} WasmAudioConfig
 * @property {number} sampleRate
 * @property {number} channels
 * @property {number} bitsPerSample
 * @property {number} framesPerChunk
 */

/**
 * WASM Engine callbacks
 * @typedef {Object} WasmEngineCallbacks
 * @property {Function} [onSignalingXmpp]
 * @property {Function} [onCallEvent]
 * @property {Function} [onVoipReady]
 * @property {Function} [sendDataToRelay]
 * @property {Function} [onLog]
 * @property {Function} [onAudioCaptureInit]
 * @property {Function} [onAudioCaptureStart]
 * @property {Function} [onAudioCaptureStop]
 * @property {Function} [onAudioPlaybackInit]
 * @property {Function} [onAudioPlaybackStart]
 * @property {Function} [onAudioPlaybackStop]
 * @property {Function} [onAudioPlaybackData]
 * @property {Function} [onVideoFrame]
 * @property {Function} [cryptoHkdf]
 * @property {Function} [hmacSha256]
 */

/**
 * WASM Engine configuration
 * @typedef {Object} WasmEngineConfig
 * @property {string} [resourcesPath]
 * @property {string} [wasmPath]
 * @property {Uint8Array} [wasmBinary]
 * @property {string} [loaderCode]
 * @property {string} [workerModulesCode]
 * @property {string} [loaderModuleName]
 * @property {WasmEngineCallbacks} [callbacks]
 * @property {boolean} [enableLogs]
 * @property {Object} [options]
 */

/**
 * Relay transport configuration
 * @typedef {Object} RelayTransportConfig
 * @property {Function} onTransportMessage
 * @property {Function} [onIceRtt]
 */

/**
 * Relay transport statistics
 * @typedef {Object} RelayTransportStats
 * @property {number} sentPackets
 * @property {number} receivedPackets
 * @property {number} sentBytes
 * @property {number} receivedBytes
 * @property {number} droppedPackets
 * @property {number} openConnections
 */

module.exports = {
	CallState
}
