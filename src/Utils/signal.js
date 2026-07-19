'use strict'
Object.defineProperty(exports, '__esModule', { value: true })
exports.getNextPreKeysNode =
	exports.getNextPreKeys =
	exports.extractDeviceJids =
	exports.parseAndInjectE2ESessions =
	exports.xmppPreKey =
	exports.xmppSignedPreKey =
	exports.generateOrGetPreKeys =
	exports.getPreKeys =
	exports.createSignalIdentity =
		void 0
const Defaults_1 = require('../Defaults')
const WABinary_1 = require('../WABinary')
const crypto_1 = require('./crypto')
const generics_1 = require('./generics')
function chunk(array, size) {
	const chunks = []
	for (let i = 0; i < array.length; i += size) {
		chunks.push(array.slice(i, i + size))
	}
	return chunks
}
const createSignalIdentity = (wid, accountSignatureKey) => {
	return {
		identifier: { name: wid, deviceId: 0 },
		identifierKey: (0, crypto_1.generateSignalPubKey)(accountSignatureKey)
	}
}
exports.createSignalIdentity = createSignalIdentity
const getPreKeys = async ({ get }, min, limit) => {
	const idList = []
	for (let id = min; id < limit; id++) {
		idList.push(id.toString())
	}
	return get('pre-key', idList)
}
exports.getPreKeys = getPreKeys
const generateOrGetPreKeys = (creds, range) => {
	const avaliable = creds.nextPreKeyId - creds.firstUnuploadedPreKeyId
	const remaining = range - avaliable
	const lastPreKeyId = creds.nextPreKeyId + remaining - 1
	const newPreKeys = {}
	if (remaining > 0) {
		for (let i = creds.nextPreKeyId; i <= lastPreKeyId; i++) {
			newPreKeys[i] = crypto_1.Curve.generateKeyPair()
		}
	}
	return {
		newPreKeys,
		lastPreKeyId,
		preKeysRange: [creds.firstUnuploadedPreKeyId, range]
	}
}
exports.generateOrGetPreKeys = generateOrGetPreKeys
// cipherSuite: 0x05 = X25519/Curve25519 (standard Signal), 0x2a = Kyber-1024 (PQXDH) —
// only pass it when mixing in a non-default cipher; omit for plain Curve25519 uploads.
const xmppSignedPreKey = (key, cipherSuite) => ({
	tag: 'skey',
	attrs: cipherSuite !== undefined ? { key_cipher_suite: cipherSuite } : {},
	content: [
		{ tag: 'id', attrs: {}, content: (0, generics_1.encodeBigEndian)(key.keyId, 3) },
		{ tag: 'value', attrs: {}, content: key.keyPair.public },
		{ tag: 'signature', attrs: {}, content: key.signature }
	]
})
exports.xmppSignedPreKey = xmppSignedPreKey
const xmppPreKey = (pair, id, cipherSuite) => ({
	tag: 'key',
	attrs: cipherSuite !== undefined ? { key_cipher_suite: cipherSuite } : {},
	content: [
		{ tag: 'id', attrs: {}, content: (0, generics_1.encodeBigEndian)(id, 3) },
		{ tag: 'value', attrs: {}, content: pair.public }
	]
})
exports.xmppPreKey = xmppPreKey
const parseAndInjectE2ESessions = async (node, repository) => {
	const extractKey = key => {
		if (!key) return undefined
		const cipherSuite = key.attrs?.key_cipher_suite
		return {
			keyId: (0, WABinary_1.getBinaryNodeChildUInt)(key, 'id', 3),
			publicKey: (0, crypto_1.generateSignalPubKey)((0, WABinary_1.getBinaryNodeChildBuffer)(key, 'value')),
			signature: (0, WABinary_1.getBinaryNodeChildBuffer)(key, 'signature'),
			// 0x05 = Curve25519 (standard Signal), 0x2a = Kyber-1024 (PQXDH)
			...(cipherSuite !== undefined ? { cipherSuite } : {})
		}
	}
	const nodes = (0, WABinary_1.getBinaryNodeChildren)((0, WABinary_1.getBinaryNodeChild)(node, 'list'), 'user')
	for (const node of nodes) {
		;(0, WABinary_1.assertNodeErrorFree)(node)
	}
	// Most of the work in repository.injectE2ESession is CPU intensive, not IO
	// So Promise.all doesn't really help here,
	// but blocks even loop if we're using it inside keys.transaction, and it makes it "sync" actually
	// This way we chunk it in smaller parts and between those parts we can yield to the event loop
	// It's rare case when you need to E2E sessions for so many users, but it's possible
	const chunkSize = 100
	const chunks = chunk(nodes, chunkSize)
	for (const nodesChunk of chunks) {
		for (const node of nodesChunk) {
			const signedKey = (0, WABinary_1.getBinaryNodeChild)(node, 'skey')
			const key = (0, WABinary_1.getBinaryNodeChild)(node, 'key')
			const identity = (0, WABinary_1.getBinaryNodeChildBuffer)(node, 'identity')
			const jid = node.attrs.jid
			const registrationId = (0, WABinary_1.getBinaryNodeChildUInt)(node, 'registration', 4)
			await repository.injectE2ESession({
				jid,
				session: {
					registrationId: registrationId,
					identityKey: (0, crypto_1.generateSignalPubKey)(identity),
					signedPreKey: extractKey(signedKey),
					preKey: extractKey(key)
				}
			})
		}
	}
}
exports.parseAndInjectE2ESessions = parseAndInjectE2ESessions
const extractDeviceJids = (result, myJid, myLid, excludeZeroDevices) => {
	const { user: myUser, device: myDevice } = (0, WABinary_1.jidDecode)(myJid)
	const extracted = []
	for (const userResult of result) {
		const { devices, id } = userResult
		const decoded = (0, WABinary_1.jidDecode)(id),
			{ user, server } = decoded
		let { domainType } = decoded
		const deviceList = devices?.deviceList
		if (!Array.isArray(deviceList)) continue
		for (const { id: device, keyIndex, isHosted } of deviceList) {
			if (
				(!excludeZeroDevices || device !== 0) && // if zero devices are not-excluded, or device is non zero
				((myUser !== user && myLid !== user) || myDevice !== device) && // either different user or if me user, not this device
				(device === 0 || !!keyIndex) // ensure that "key-index" is specified for "non-zero" devices, produces a bad req otherwise
			) {
				if (isHosted) {
					domainType =
						domainType === WABinary_1.WAJIDDomains.LID
							? WABinary_1.WAJIDDomains.HOSTED_LID
							: WABinary_1.WAJIDDomains.HOSTED
				}
				extracted.push({
					user,
					device,
					domainType,
					server: (0, WABinary_1.getServerFromDomainType)(server, domainType)
				})
			}
		}
	}
	return extracted
}
exports.extractDeviceJids = extractDeviceJids
/**
 * get the next N keys for upload or processing
 * @param count number of pre-keys to get or generate
 */
const getNextPreKeys = async ({ creds, keys }, count) => {
	const { newPreKeys, lastPreKeyId, preKeysRange } = (0, exports.generateOrGetPreKeys)(creds, count)
	const update = {
		nextPreKeyId: Math.max(lastPreKeyId + 1, creds.nextPreKeyId),
		firstUnuploadedPreKeyId: Math.max(creds.firstUnuploadedPreKeyId, lastPreKeyId + 1)
	}
	await keys.set({ 'pre-key': newPreKeys })
	const preKeys = await (0, exports.getPreKeys)(keys, preKeysRange[0], preKeysRange[0] + preKeysRange[1])
	return { update, preKeys }
}
exports.getNextPreKeys = getNextPreKeys
const getNextPreKeysNode = async (state, count) => {
	const { creds } = state
	const { update, preKeys } = await (0, exports.getNextPreKeys)(state, count)
	const node = {
		tag: 'iq',
		attrs: {
			xmlns: 'encrypt',
			type: 'set',
			to: WABinary_1.S_WHATSAPP_NET
		},
		content: [
			{ tag: 'registration', attrs: {}, content: (0, generics_1.encodeBigEndian)(creds.registrationId) },
			{ tag: 'type', attrs: {}, content: Defaults_1.KEY_BUNDLE_TYPE },
			{ tag: 'identity', attrs: {}, content: creds.signedIdentityKey.public },
			// key_cipher_suite is only sent when the bundle mixes in a non-default cipher
			// (e.g. Kyber/PQXDH alongside Curve25519) — a plain Curve25519-only upload
			// omits it entirely on real clients, confirmed against live capture.
			{ tag: 'list', attrs: {}, content: Object.keys(preKeys).map(k => (0, exports.xmppPreKey)(preKeys[+k], +k)) },
			(0, exports.xmppSignedPreKey)(creds.signedPreKey)
		]
	}
	return { update, node }
}
exports.getNextPreKeysNode = getNextPreKeysNode
