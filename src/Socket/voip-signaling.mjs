/**
 * Signaling bridge.
 *
 * Glues the WASM VoIP stack to Baileys: encrypts outbound offer / enc_rekey
 * stanzas, decrypts inbound ones, manages TC tokens, multi-device JID routing,
 * and signal-session refresh.
 *
 * @author ShellTear
 */

import fs from 'fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const require = createRequire(import.meta.url)

// Local CommonJS modules — required directly (not via the `baron-baileys-v2` package
// name) to avoid a circular import, since this file lives inside that package itself.
const { encodeBinaryNode } = require('../WABinary/encode.js')
const { decodeBinaryNode } = require('../WABinary/decode.js')
const { getBinaryNodeChild, getAllBinaryNodeChildren } = require('../WABinary/generic-utils.js')
const { unpadRandomMax16, encodeWAMessage } = require('../Utils/generics.js')
const { parseAndInjectE2ESessions } = require('../Utils/signal.js')
const { encodeSignedDeviceIdentity } = require('../Utils/validate-connection.js')
const { jidDecode, jidEncode, jidNormalizedUser } = require('../WABinary/jid-utils.js')
const { proto } = require('../../WAProto/index.js')

const baileys = {
	encodeBinaryNode,
	decodeBinaryNode,
	getBinaryNodeChild,
	getAllBinaryNodeChildren,
	unpadRandomMax16,
	encodeWAMessage,
	parseAndInjectE2ESessions,
	encodeSignedDeviceIdentity,
	jidDecode,
	jidEncode,
	jidNormalizedUser,
	proto
}

const S_WHATSAPP_NET = '@s.whatsapp.net'
const TC_TOKEN_REQUEST_TIMEOUT_MS = 3500
const SESSION_CACHE_TTL_MS = 5 * 60_000

let _sigSeq = 0
const _sigOracle = (k, o) => {
	try {
		const rec = { seq: _sigSeq++, t: Date.now(), src: 'signaling', k }
		for (const key in o) {
			const v = o[key]
			rec[key] = v && (v instanceof Uint8Array || Buffer.isBuffer(v)) ? Buffer.from(v).toString('hex') : v
		}
		const p = (typeof process !== 'undefined' && process.env && process.env.CALL_ORACLE_PATH) || 'voip-oracle.jsonl'
		fs.appendFileSync(p, JSON.stringify(rec) + '\n')
	} catch {}
}

const ACK_TIMEOUT_MS = 15_000

// encodeBinaryNode is only used for logging; if unavailable, logging is skipped (see _logStanza)

const getNodeChildren = node => (Array.isArray(node.content) ? node.content : [])

const setNodeChildren = (node, children) => {
	node.content = children.length ? children : undefined
}

const _decodeMaybeB64 = v => {
	try {
		if (v == null) return null
		if (v instanceof Uint8Array || Buffer.isBuffer(v)) return Buffer.from(v)
		if (typeof v === 'string') return Buffer.from(v, 'base64')
	} catch {}
	return null
}

let _stanzaSeq = 0
const _toHexIfBin = v => (v && (v instanceof Uint8Array || Buffer.isBuffer(v)) ? Buffer.from(v).toString('hex') : v)

const _serializeNode = n => {
	if (n == null || typeof n !== 'object') return n
	const attrs = {}
	for (const k in n.attrs || {}) attrs[k] = _toHexIfBin(n.attrs[k])
	const out = { tag: n.tag, attrs }
	if (Array.isArray(n.content)) out.content = n.content.map(_serializeNode)
	else if (n.content != null) out.content = _toHexIfBin(n.content)
	return out
}

const _logStanza = (dir, phase, node, extra) => {
	try {
		let b64
		try {
			// Try to get encodeBinaryNode from socket or WABinary if available
			const enc =
				typeof globalThis?.WABinary?.encodeBinaryNode === 'function' ? globalThis.WABinary.encodeBinaryNode : null
			if (enc) b64 = Buffer.from(enc(node)).toString('base64')
		} catch {}
		const rec = {
			seq: _stanzaSeq++,
			t: Date.now(),
			src: 'stanza',
			dir,
			phase,
			tag: node?.tag,
			attrs_top: node?.attrs ? Object.keys(node.attrs) : [],
			tree: _serializeNode(node),
			b64,
			...(extra || {})
		}
		const p = (typeof process !== 'undefined' && process.env && process.env.CALL_STANZA_PATH) || 'voip-stanzas.jsonl'
		fs.appendFileSync(p, JSON.stringify(rec) + '\n')
	} catch {}
}

const _captureHbhMaster = root => {
	const HBH_ATTRS = ['t_signal', 'transport_signal', 'hbh_key', 'key', 'auth_token', 'token']
	const stack = [root]
	while (stack.length) {
		const n = stack.pop()
		if (!n || typeof n !== 'object') continue
		const attrs = n.attrs || {}
		for (const a of HBH_ATTRS) {
			if (attrs[a] == null) continue
			const raw = _decodeMaybeB64(attrs[a])
			const isHbh = (a === 't_signal' || a === 'transport_signal' || a === 'hbh_key') && !!raw && raw.length === 30
			_sigOracle('hbh_attr', {
				node: n.tag,
				attr: a,
				len: raw ? raw.length : 0,
				value: typeof attrs[a] === 'string' ? attrs[a] : undefined,
				decoded: raw ?? undefined,
				...(isHbh ? { hbh_salt: raw.subarray(0, 14), hbh_master: raw.subarray(14, 30) } : {})
			})
		}
		for (const c of getNodeChildren(n)) stack.push(c)
	}
}

const replaceNodeChild = (node, tag, nextChild) => {
	const children = getNodeChildren(node)
	const index = children.findIndex(c => c.tag === tag)
	if (index >= 0) children[index] = nextChild
	else children.push(nextChild)
	setNodeChildren(node, children)
}

const removeNodeChildrenByTag = (node, tag) => {
	setNodeChildren(
		node,
		getNodeChildren(node).filter(c => c.tag !== tag)
	)
}

const parseCountAttr = (value, fallback = 0) => {
	const parsed = Number(value)
	return Number.isFinite(parsed) ? parsed : fallback
}

class SignalingBridge {
	constructor(config) {
		this.sock = config.sock
		this.baileys = baileys
		this.voip = null
		this.observedTcTokens = new Map()
		this.pendingTcTokenWaiters = new Map()
		this.ensuredSignalSessions = new Map()
		this.remoteDevicePeerByCallId = new Map()
		this.remoteObfuscatedPeerByCallId = new Map()
		this.remoteXmppRoutePeerByCallId = new Map()
		this.incomingCallPeerById = new Map()
		this.outgoingSignalingQueue = Promise.resolve(undefined)
		this.incomingSignalingQueue = Promise.resolve(undefined)
	}

	attachEngine(voip) {
		this.voip = voip
	}

	async init() {
		// Note: baileys module is only used for optional logging; not required for functionality
		const originalKeysSet = this.sock.authState.keys.set.bind(this.sock.authState.keys)
		this.sock.authState.keys.set = async data => {
			const result = await originalKeysSet(data)
			for (const [jid, entry] of Object.entries(data?.tctoken ?? {})) {
				if (entry?.token instanceof Uint8Array && entry.token.length > 0) {
					this.rememberTcToken(jid, entry.token, entry.timestamp)
				}
			}
			return result
		}
	}

	sendSignaling(peerJid, callId, xmlPayload) {
		this.outgoingSignalingQueue = this.outgoingSignalingQueue
			.then(() => this.doSendSignaling(peerJid, callId, xmlPayload))
			.catch(() => {})
	}

	processIncomingCall(node, voip, activeCallId) {
		this.incomingSignalingQueue = this.incomingSignalingQueue
			.then(() => this.doProcessIncomingCall(node, voip, activeCallId))
			.catch(() => {})
	}

	processIncomingReceipt(node, voip, activeCallId) {
		this.incomingSignalingQueue = this.incomingSignalingQueue
			.then(() => this.doProcessIncomingReceipt(node, voip, activeCallId))
			.catch(() => {})
	}

	async requestTcToken(jid) {
		const userJid = this.toBareJid(jid)
		const cached = await this.getTcToken(userJid)
		if (cached?.length) return cached

		try {
			const response = await this.sock.getPrivacyTokens([userJid])
			const { getBinaryNodeChild, getAllBinaryNodeChildren } = this.baileys
			const tokensNode =
				getBinaryNodeChild(response, 'tokens') ?? getBinaryNodeChild(getBinaryNodeChild(response, 'iq'), 'tokens')
			const tokenNodes = tokensNode ? getAllBinaryNodeChildren(tokensNode).filter(c => c.tag === 'token') : []

			for (const tokenNode of tokenNodes) {
				const tokenJid = String(tokenNode.attrs.jid ?? '')
				if (this.baileys.jidNormalizedUser(tokenJid) !== this.baileys.jidNormalizedUser(userJid)) continue
				const content = tokenNode.content
				if (content instanceof Uint8Array && content.length > 0) {
					const token = Buffer.from(content)
					await this.sock.authState.keys.set({
						tctoken: { [userJid]: { token, timestamp: String(tokenNode.attrs.t ?? '') } }
					})
					return token
				}
			}
		} catch {}

		return this.getTcToken(userJid)
	}

	async ensureTcToken(...jids) {
		const uniqueJids = [...new Set(jids.map(j => this.toBareJid(String(j ?? '').trim())).filter(Boolean))]
		for (const jid of uniqueJids) {
			const cached = await this.getTcToken(jid)
			if (cached?.length) return cached
		}
		for (const jid of uniqueJids) {
			const fetched = await Promise.race([
				this.requestTcToken(jid),
				new Promise(r => setTimeout(() => r(undefined), TC_TOKEN_REQUEST_TIMEOUT_MS))
			])
			if (fetched?.length) return fetched
		}
		return undefined
	}

	async discoverPeerDevices(peerLidJid) {
		const devices = await this.sock.getUSyncDevices([peerLidJid], true, false)
		return this.normalizeStartCallPeerList(devices.map(d => d.jid).filter(Boolean))
	}

	async ensureSessionsForPeers(jids) {
		const targets = this.expandSignalSessionTargets(jids)
		if (targets.length) await this.ensureSignalSessions(targets, true)
	}

	async resolveLid(pnJid) {
		return this.sock.signalRepository.lidMapping?.getLIDForPN(pnJid)
	}

	async issueTcToken(jid) {
		const userJid = this.toBareJid(jid)
		const issuedAt = Math.floor(Date.now() / 1000)
		try {
			await this.sock.query({
				tag: 'iq',
				attrs: {
					to: S_WHATSAPP_NET,
					type: 'set',
					xmlns: 'privacy',
					id: this.sock.generateMessageTag()
				},
				content: [
					{
						tag: 'tokens',
						attrs: {},
						content: [
							{
								tag: 'token',
								attrs: { jid: userJid, t: String(issuedAt), type: 'trusted_contact' }
							}
						]
					}
				]
			})
			return true
		} catch {
			return false
		}
	}

	getRemoteDeviceJid(callId) {
		return this.remoteDevicePeerByCallId.get(callId)
	}

	// ─── private ─ outbound signaling ──────────────────────────────────────────────

	async doSendSignaling(peerJid, callId, xmlPayload) {
		const { decodeBinaryNode, getBinaryNodeChild } = this.baileys

		const rawPayload = Buffer.from(xmlPayload)
		let voipNode
		try {
			voipNode = await decodeBinaryNode(Buffer.concat([Buffer.from([0]), rawPayload]))
		} catch {
			voipNode = await decodeBinaryNode(rawPayload)
		}

		const signalingTag = String(voipNode.tag)
		_logStanza('out', `outgoing:${signalingTag}`, voipNode)
		_captureHbhMaster(voipNode)
		const effectivePeerJid = this.resolveOutboundPeerJid(callId, peerJid)

		if (signalingTag === 'offer' && !voipNode.attrs['call-creator']) {
			const selfLid = this.sock.authState.creds.me?.lid
			if (selfLid) voipNode.attrs['call-creator'] = selfLid
		}

		const destination = getBinaryNodeChild(voipNode, 'destination')
		if (destination) {
			const destinations = getNodeChildren(destination)
			const destinationJids = destinations.map(n => String(n.attrs.jid ?? '').trim()).filter(Boolean)
			const sessionTargets = this.expandSignalSessionTargets(destinationJids)
			if (sessionTargets.length) await this.ensureSignalSessions(sessionTargets, signalingTag === 'offer')

			const rootEnc = getBinaryNodeChild(voipNode, 'enc')
			const encCount = parseCountAttr(rootEnc?.attrs.count)
			let includeDeviceIdentity = false

			for (const destNode of destinations) {
				const targetJid = String(destNode.attrs.jid ?? '').trim()
				const destEnc = getBinaryNodeChild(destNode, 'enc')
				if (!targetJid || !destEnc || !(destEnc.content instanceof Uint8Array)) continue
				try {
					const encrypted = await this.encryptCallKey(targetJid, destEnc.content, encCount)
					includeDeviceIdentity = includeDeviceIdentity || encrypted.shouldIncludeDeviceIdentity
					setNodeChildren(destNode, [encrypted.encNode])
				} catch {
					for (const d of destinations) removeNodeChildrenByTag(d, 'enc')
					break
				}
			}
			if (includeDeviceIdentity) this.appendDeviceIdentity(voipNode)

			await this.sendCallStanza(this.toBareJid(peerJid), voipNode, signalingTag, effectivePeerJid, peerJid)
			return
		}

		if (signalingTag === 'offer' || signalingTag === 'enc_rekey') {
			const enc = getBinaryNodeChild(voipNode, 'enc')
			if (enc && enc.content instanceof Uint8Array) {
				const targetJid = this.toCallDeviceJid(effectivePeerJid)
				const encrypted = await this.encryptCallKey(targetJid, enc.content, parseCountAttr(enc.attrs.count))
				replaceNodeChild(voipNode, 'enc', encrypted.encNode)
				if (encrypted.shouldIncludeDeviceIdentity) this.appendDeviceIdentity(voipNode)

				await this.sendCallStanza(targetJid, voipNode, signalingTag, effectivePeerJid, peerJid)
				return
			}
		}

		const routeTo =
			signalingTag !== 'offer' && signalingTag !== 'enc_rekey'
				? this.toBareJid(effectivePeerJid)
				: this.toCallDeviceJid(effectivePeerJid)
		await this.sendCallStanza(routeTo, voipNode, signalingTag, effectivePeerJid, peerJid)
	}

	async sendCallStanza(routeTo, voipNode, signalingTag, effectivePeerJid, callbackPeerJid) {
		const stanzaId = this.sock.generateMessageTag()
		await this.sock.sendNode({
			tag: 'call',
			attrs: { to: routeTo, id: stanzaId },
			content: [voipNode]
		})

		void (async () => {
			try {
				const ackNode = await this.sock.waitForMessage(stanzaId, ACK_TIMEOUT_MS)
				if (!ackNode || !this.voip) return
				const { encodeBinaryNode } = this.baileys
				const ackPayload = Buffer.from(encodeBinaryNode(ackNode)).toString('base64')
				const tcToken = await this.ensureTcToken(effectivePeerJid, callbackPeerJid)
				try {
					this.voip.handleSignalingAck({
						payload: ackPayload,
						ackError: ackNode.attrs?.error ?? '0',
						msgType: ackNode.attrs?.type ?? signalingTag,
						peerJid: effectivePeerJid,
						extraData: tcToken
					})
				} catch {}
			} catch {}
		})()
	}

	// ─── private ─ inbound signaling ───────────────────────────────────────────────

	async doProcessIncomingCall(node, voip, activeCallId) {
		const { getAllBinaryNodeChildren, getBinaryNodeChild, encodeBinaryNode } = this.baileys

		_logStanza('in', 'raw', node)

		const voipChild = getAllBinaryNodeChildren(node)[0]
		if (!voipChild) return

		const incomingCallId = String(voipChild.attrs['call-id'] ?? voipChild.attrs.call_id ?? '')
		const callIdForRouting = incomingCallId || activeCallId
		if (activeCallId && incomingCallId && incomingCallId !== activeCallId) return

		const senderDeviceJid =
			String(voipChild.attrs.participant ?? '') ||
			String(node.attrs.participant ?? '') ||
			String(node.attrs.from ?? '') ||
			String(voipChild.attrs['call-creator'] ?? '')
		const callbackPeerJid = String(node.attrs.from ?? '') || senderDeviceJid
		const platform = voipChild.attrs.platform ?? node.attrs.platform ?? ''
		const appVersion = voipChild.attrs.version ?? node.attrs.version ?? ''
		const epochId = voipChild.attrs.e ?? node.attrs.e ?? '0'
		const timestamp = voipChild.attrs.t ?? node.attrs.t ?? '0'
		const offline = !!(voipChild.attrs.offline ?? node.attrs.offline)

		let usableNode = voipChild
		if (getBinaryNodeChild(voipChild, 'enc')) {
			usableNode = await this.maybeDecryptEnc(voipChild, senderDeviceJid)
		}

		const b64 = Buffer.from(encodeBinaryNode(usableNode)).toString('base64')

		_logStanza('in', `decrypted:${usableNode?.tag ?? '?'}`, usableNode, { callId: callIdForRouting })
		_captureHbhMaster(usableNode)

		const storedPeerJid = callIdForRouting ? this.incomingCallPeerById.get(callIdForRouting) : undefined
		let mappedRemoteDeviceJid = callIdForRouting ? this.remoteDevicePeerByCallId.get(callIdForRouting) : undefined

		if (callIdForRouting && (callbackPeerJid || senderDeviceJid)) {
			this.remoteXmppRoutePeerByCallId.set(callIdForRouting, callbackPeerJid || senderDeviceJid)
			const hinted = this.pickConcreteRouteHint(senderDeviceJid, callbackPeerJid)
			if (hinted && hinted !== mappedRemoteDeviceJid) {
				mappedRemoteDeviceJid = hinted
				this.remoteDevicePeerByCallId.set(callIdForRouting, hinted)
			}
		}

		const routedPeerJid =
			usableNode.tag === 'offer'
				? this.preferDeviceRouteJid(senderDeviceJid, callbackPeerJid, storedPeerJid)
				: this.preferOrderedRouteJid(mappedRemoteDeviceJid, storedPeerJid, senderDeviceJid, callbackPeerJid)

		if (callIdForRouting && routedPeerJid) {
			this.incomingCallPeerById.set(callIdForRouting, routedPeerJid)
		}

		const tcToken = await this.ensureTcToken(routedPeerJid, callbackPeerJid)

		switch (usableNode.tag) {
			case 'offer':
				voip.handleSignalingOffer({
					payload: b64,
					peerPlatform: Number(platform || 0),
					peerAppVersion: appVersion,
					epochId,
					timestamp,
					isOffline: offline,
					isOfferNotContact: false,
					peerJid: routedPeerJid,
					tcToken
				})
				break
			case 'ack':
				voip.handleSignalingAck({
					payload: b64,
					ackError: usableNode.attrs.error ?? '0',
					msgType: usableNode.attrs.type ?? '',
					peerJid: routedPeerJid,
					extraData: tcToken
				})
				break
			default:
				voip.handleSignalingMessage({
					payload: b64,
					peerPlatform: platform,
					peerAppVersion: appVersion,
					epochId,
					timestamp,
					isOffline: offline,
					peerJid: routedPeerJid,
					tcToken
				})
				if (callIdForRouting && (usableNode.tag === 'terminate' || usableNode.tag === 'reject')) {
					this.incomingCallPeerById.delete(callIdForRouting)
					this.remoteDevicePeerByCallId.delete(callIdForRouting)
					this.remoteObfuscatedPeerByCallId.delete(callIdForRouting)
					this.remoteXmppRoutePeerByCallId.delete(callIdForRouting)
				}
				break
		}
	}

	async doProcessIncomingReceipt(node, voip, activeCallId) {
		const { getAllBinaryNodeChildren, encodeBinaryNode } = this.baileys
		const receiptChild = getAllBinaryNodeChildren(node)[0]
		if (!receiptChild) return

		const incomingCallId = String(receiptChild.attrs['call-id'] ?? receiptChild.attrs.call_id ?? '')
		const callIdForRouting = incomingCallId || activeCallId
		if (activeCallId && incomingCallId && incomingCallId !== activeCallId) return

		const callbackPeerJid = String(node.attrs.from ?? receiptChild.attrs['call-creator'] ?? '')
		const storedPeerJid = callIdForRouting ? this.incomingCallPeerById.get(callIdForRouting) : undefined
		const routedPeerJid = this.preferOrderedRouteJid(storedPeerJid, callbackPeerJid)
		if (callIdForRouting && routedPeerJid) this.incomingCallPeerById.set(callIdForRouting, routedPeerJid)

		const tcToken = await this.ensureTcToken(routedPeerJid, callbackPeerJid)
		voip.handleSignalingReceipt({
			payload: Buffer.from(encodeBinaryNode(node)).toString('base64'),
			peerJid: routedPeerJid,
			tcToken
		})
	}

	async maybeDecryptEnc(voipNode, peerJid) {
		const { getBinaryNodeChild, unpadRandomMax16, proto } = this.baileys
		const enc = getBinaryNodeChild(voipNode, 'enc')
		if (!enc || !(enc.content instanceof Uint8Array)) return voipNode
		const type = enc.attrs.type
		if (type !== 'pkmsg' && type !== 'msg') return voipNode

		const candidates = [...new Set([peerJid, this.toCallDeviceJid(peerJid)])].filter(Boolean)
		let lastErr
		for (const jid of candidates) {
			try {
				const decrypted = await this.sock.signalRepository.decryptMessage({
					jid,
					type,
					ciphertext: enc.content
				})
				const parsed = proto.Message.decode(unpadRandomMax16(decrypted))
				const callKey = parsed.call?.callKey
				if (!callKey || callKey.length === 0) {
					throw new Error('decrypted signaling has no call.callKey')
				}
				_sigOracle('callkey_rx', { jid, len: callKey.length, callKey })
				enc.content = callKey
				return voipNode
			} catch (err) {
				lastErr = err
			}
		}
		throw lastErr
	}

	async encryptCallKey(targetJid, rawCallKey, count) {
		_sigOracle('callkey_tx', { targetJid, len: rawCallKey.length, callKey: rawCallKey })
		const { encodeWAMessage } = this.baileys
		const primaryDeviceJid = this.toPrimaryDeviceJid(targetJid)
		const sessionTargets =
			primaryDeviceJid && primaryDeviceJid !== targetJid ? [primaryDeviceJid, targetJid] : [targetJid]
		await this.ensureSignalSessions(sessionTargets, false)

		const { type, ciphertext } = await this.sock.signalRepository.encryptMessage({
			jid: targetJid,
			data: encodeWAMessage({ call: { callKey: Buffer.from(rawCallKey) } })
		})

		return {
			encNode: {
				tag: 'enc',
				attrs: { v: '2', type, count: String(count) },
				content: Buffer.from(ciphertext)
			},
			shouldIncludeDeviceIdentity: type === 'pkmsg'
		}
	}

	async ensureSignalSessions(jids, refresh) {
		const { parseAndInjectE2ESessions } = this.baileys
		const missing = []

		for (const jid of [...new Set(jids.filter(Boolean))]) {
			const signalId = this.sock.signalRepository.jidToSignalProtocolAddress(jid)
			const cachedAt = this.ensuredSignalSessions.get(signalId)
			if (!refresh && cachedAt && Date.now() - cachedAt < SESSION_CACHE_TTL_MS) continue
			if (!refresh) {
				const validation = await this.sock.signalRepository.validateSession(jid)
				if (validation.exists) {
					this.ensuredSignalSessions.set(signalId, Date.now())
					continue
				}
			}
			missing.push(jid)
		}
		if (!missing.length) return

		const sessionNode = await this.sock.query({
			tag: 'iq',
			attrs: { xmlns: 'encrypt', type: 'get', to: S_WHATSAPP_NET },
			content: [
				{
					tag: 'key',
					attrs: {},
					content: missing.map(jid => ({ tag: 'user', attrs: { jid } }))
				}
			]
		})
		await parseAndInjectE2ESessions(sessionNode, this.sock.signalRepository)
		for (const jid of missing) {
			this.ensuredSignalSessions.set(this.sock.signalRepository.jidToSignalProtocolAddress(jid), Date.now())
		}
	}

	appendDeviceIdentity(voipNode) {
		const { getBinaryNodeChild, encodeSignedDeviceIdentity } = this.baileys
		if (getBinaryNodeChild(voipNode, 'device-identity')) return
		const account = this.sock.authState.creds.account
		if (!account) return
		const children = getNodeChildren(voipNode)
		children.push({
			tag: 'device-identity',
			attrs: {},
			content: encodeSignedDeviceIdentity(account, true)
		})
		setNodeChildren(voipNode, children)
	}

	// ─── private ─ JID utilities ────────────────────────────────────────────────────

	toBareJid(jid) {
		const { jidDecode, jidEncode } = this.baileys
		const decoded = jidDecode(jid)
		if (!decoded?.user) return jid
		const server = jid.endsWith('@lid') ? 'lid' : 's.whatsapp.net'
		return jidEncode(decoded.user, server)
	}

	toCallDeviceJid(jid) {
		const { jidDecode, jidEncode } = this.baileys
		const decoded = jidDecode(jid)
		if (!decoded?.user) return jid
		const server = jid.endsWith('@lid') ? 'lid' : 's.whatsapp.net'
		if (decoded.device == null) return jidEncode(decoded.user, server)
		return `${decoded.user}:${decoded.device}@${server}`
	}

	toPrimaryDeviceJid(jid) {
		const { jidDecode, jidEncode } = this.baileys
		const decoded = jidDecode(jid)
		if (!decoded?.user) return undefined
		const device = decoded.device
		if (device == null || device === 0) return undefined
		const server = jid.endsWith('@lid') ? 'lid' : 's.whatsapp.net'
		return jidEncode(decoded.user, server)
	}

	hasConcreteDevice(jid) {
		const decoded = this.baileys.jidDecode(jid)
		return !!decoded?.user && decoded.device != null
	}

	preferDeviceRouteJid(...candidates) {
		for (const c of candidates) {
			const jid = String(c ?? '').trim()
			if (jid && this.hasConcreteDevice(jid)) return jid
		}
		for (const c of candidates) {
			const jid = String(c ?? '').trim()
			if (jid) return this.toCallDeviceJid(jid)
		}
		return ''
	}

	preferOrderedRouteJid(...candidates) {
		for (const c of candidates) {
			const jid = String(c ?? '').trim()
			if (jid) return this.toCallDeviceJid(jid)
		}
		return ''
	}

	pickConcreteRouteHint(...candidates) {
		for (const c of candidates) {
			const jid = String(c ?? '').trim()
			if (jid && this.hasConcreteDevice(jid)) return jid
		}
		return ''
	}

	resolveOutboundPeerJid(callId, wasmPeerJid) {
		const peerJid = String(wasmPeerJid ?? '').trim()
		if (!peerJid || !callId) return peerJid
		return this.remoteDevicePeerByCallId.get(callId) ?? peerJid
	}

	expandSignalSessionTargets(jids) {
		return [
			...new Set(
				jids.flatMap(jid => {
					const primary = this.toPrimaryDeviceJid(jid)
					return primary && primary !== jid ? [primary, jid] : [jid]
				})
			)
		]
	}

	normalizeStartCallPeerList(jids) {
		const { jidDecode, jidEncode } = this.baileys
		const result = new Set()
		for (const jid of jids) {
			const decoded = jidDecode(jid)
			if (!decoded?.user) {
				result.add(jid)
				continue
			}
			const server = jid.endsWith('@lid') ? 'lid' : 's.whatsapp.net'
			result.add(jidEncode(decoded.user, server))
			if (decoded.device != null) {
				result.add(`${decoded.user}:${decoded.device}@${server}`)
			}
		}
		return [...result].slice(0, 5)
	}

	// ─── private ─ TC token ────────────────────────────────────────────────────────

	rememberTcToken(jid, token, timestamp = '') {
		const bareJid = this.toBareJid(jid)
		if (!token.length) return
		this.observedTcTokens.set(bareJid, { token: Buffer.from(token), timestamp })
		const waiters = this.pendingTcTokenWaiters.get(bareJid)
		if (waiters?.length) {
			this.pendingTcTokenWaiters.delete(bareJid)
			for (const w of waiters) w(Buffer.from(token))
		}
	}

	async getTcToken(jid) {
		const userJid = this.toBareJid(jid)
		const observed = this.observedTcTokens.get(userJid)?.token
		if (observed?.length) return Buffer.from(observed)
		try {
			const data = await this.sock.authState.keys.get('tctoken', [userJid])
			const token = data[userJid]?.token
			if (token && token.length > 0) {
				this.rememberTcToken(userJid, token, data[userJid]?.timestamp)
				return token
			}
		} catch {}
		return undefined
	}
}

export { SignalingBridge }
