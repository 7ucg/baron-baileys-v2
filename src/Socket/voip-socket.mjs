import path from 'node:path'
import { VoipClient, ActiveCall, CallState } from './voip.mjs'

// Import dependencies to pass to VoipClient
// These need to be passed in since voip.mjs is part of this library
const getAuthDependencies = async () => {
	// Import from the main library exports
	const baileyModule = await import('../index.js')
	const { useMultiFileAuthState, DisconnectReason, makeWASocket } = baileyModule
	return { useMultiFileAuthState, DisconnectReason, makeWASocket: makeWASocket || baileyModule.default }
}

/**
 * Attach VoIP/Voice Calling support to Socket
 * Enables sock.call(phoneNumber, opts) for voice calling
 */
const makeVoipSocket = sock => {
	let voipClient = null
	let voipConnected = false

	// Helper to get VoIP client (lazy init)
	let authDeps = null
	const getVoipClient = async () => {
		if (!voipClient) {
			if (!authDeps) {
				authDeps = await getAuthDependencies()
			}
			const authDir = sock.authState?.creds?.accountHash
				? path.join(process.cwd(), `auth-voip-${sock.authState.creds.accountHash.slice(0, 8)}`)
				: path.join(process.cwd(), 'auth-voip')
			voipClient = new VoipClient({
				authDir,
				useMultiFileAuthState: authDeps.useMultiFileAuthState,
				makeWASocket: authDeps.makeWASocket,
				DisconnectReason: authDeps.DisconnectReason
			})
		}
		return voipClient
	}

	// Attach to socket
	sock.voip = {
		CallState,
		isConnected: false,
		activeCall: null
	}

	/**
	 * Connect VoIP stack
	 * Must be called once before making/receiving calls
	 */
	sock.voip.connect = async () => {
		try {
			const client = await getVoipClient()
			await client.connect()
			voipConnected = true
			sock.voip.isConnected = true
			sock.ev.emit('voip.connected')
			return client
		} catch (err) {
			sock.logger?.error?.({ err }, 'VoIP connection failed')
			throw err
		}
	}

	/**
	 * Place an outbound voice call
	 * @param {string} phoneNumber - Target phone number (digits only)
	 * @param {Object} opts - Call options
	 * @param {string} [opts.audioSource] - Audio source: file path or "silence"
	 * @param {number} [opts.durationMs] - Auto-hangup after N ms (default: 120000)
	 * @param {boolean} [opts.isVideo] - Start as video call
	 * @returns {Promise<ActiveCall>}
	 */
	sock.voip.call = async (phoneNumber, opts = {}) => {
		if (!voipConnected) {
			throw new Error('VoIP not connected. Call sock.voip.connect() first.')
		}
		if (sock.voip.activeCall) {
			throw new Error('A call is already active.')
		}

		try {
			const client = await getVoipClient()
			const call = await client.call(phoneNumber, opts)

			sock.voip.activeCall = call

			// Emit events through socket
			call.on('ringing', () => {
				sock.ev.emit('voip.ringing', { callId: call.callId, to: phoneNumber })
			})

			call.on('connected', () => {
				sock.ev.emit('voip.connected-call', { callId: call.callId, to: phoneNumber })
			})

			call.on('audio', pcm => {
				sock.ev.emit('voip.audio', { callId: call.callId, pcm, length: pcm.length })
			})

			call.on('video', frame => {
				sock.ev.emit('voip.video', { callId: call.callId, frame })
			})

			call.on('ended', reason => {
				sock.voip.activeCall = null
				sock.ev.emit('voip.ended', { callId: call.callId, reason })
			})

			call.on('error', err => {
				sock.voip.activeCall = null
				sock.ev.emit('voip.error', { callId: call.callId, error: err })
			})

			return call
		} catch (err) {
			sock.logger?.error?.({ phoneNumber, err }, 'Failed to start call')
			throw err
		}
	}

	/**
	 * End active call
	 */
	sock.voip.hangup = () => {
		if (sock.voip.activeCall) {
			sock.voip.activeCall.end()
			sock.voip.activeCall = null
		}
	}

	/**
	 * Mute/unmute active call microphone
	 */
	sock.voip.setMute = (muted = true) => {
		if (sock.voip.activeCall) {
			sock.voip.activeCall.mute(muted)
		}
	}

	/**
	 * Disconnect VoIP stack and cleanup
	 */
	sock.voip.disconnect = () => {
		if (voipClient) {
			voipClient.disconnect()
			voipClient = null
			voipConnected = false
			sock.voip.isConnected = false
			sock.voip.activeCall = null
			sock.ev.emit('voip.disconnected')
		}
	}

	/**
	 * Wait for active call to end
	 */
	sock.voip.waitForCallEnd = async () => {
		if (sock.voip.activeCall) {
			return await sock.voip.activeCall.waitForEnd()
		}
		return 'no-call'
	}

	return sock
}

export { makeVoipSocket }
