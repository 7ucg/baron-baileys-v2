'use strict'
Object.defineProperty(exports, '__esModule', { value: true })
exports.signedKeyPair =
	exports.Curve =
	exports.generateSignalPubKey =
	exports.getEnabledFeatures =
	exports.hkdf =
	exports.md5 =
		void 0
exports.aesEncryptGCM = aesEncryptGCM
exports.aesDecryptGCM = aesDecryptGCM
exports.aesEncryptCTR = aesEncryptCTR
exports.aesDecryptCTR = aesDecryptCTR
exports.aesDecrypt = aesDecrypt
exports.aesDecryptWithIV = aesDecryptWithIV
exports.aesEncrypt = aesEncrypt
exports.aesEncrypWithIV = aesEncrypWithIV
exports.hmacSign = hmacSign
exports.sha256 = sha256
exports.derivePairingCodeKey = derivePairingCodeKey
const { subtle } = globalThis.crypto
const Defaults_1 = require('../Defaults')
const rb = require('whatsapp-rust-bridge-baron')

// ── Re-exports from Rust ─────────────────────────────────────────────────────
Object.defineProperty(exports, 'md5', { enumerable: true, get: () => rb.md5 })
Object.defineProperty(exports, 'hkdf', { enumerable: true, get: () => rb.hkdf })
Object.defineProperty(exports, 'getEnabledFeatures', { enumerable: true, get: () => rb.getEnabledFeatures })

// ── Signal pub key helper ─────────────────────────────────────────────────────
const generateSignalPubKey = pubKey =>
	pubKey.length === 33 ? pubKey : Buffer.concat([Defaults_1.KEY_BUNDLE_TYPE, pubKey])
exports.generateSignalPubKey = generateSignalPubKey

// ── Curve — fully delegated to Rust bridge ────────────────────────────────────
exports.Curve = {
	generateKeyPair: () => {
		const pair = rb.generateKeyPair()
		return {
			private: Buffer.from(pair.privKey),
			public: Buffer.from(pair.pubKey).subarray(1) // strip 0x05 prefix
		}
	},
	sharedKey: (privateKey, publicKey) => Buffer.from(rb.calculateAgreement(generateSignalPubKey(publicKey), privateKey)),
	sign: (privateKey, buf) => rb.calculateSignature(privateKey, buf),
	verify: (pubKey, message, signature) => {
		try {
			return rb.verifySignature(generateSignalPubKey(pubKey), message, signature)
		} catch {
			return false
		}
	}
}

const signedKeyPair = (identityKeyPair, keyId) => {
	const preKey = exports.Curve.generateKeyPair()
	const pubKey = generateSignalPubKey(preKey.public)
	const signature = exports.Curve.sign(identityKeyPair.private, pubKey)
	return { keyPair: preKey, signature, keyId }
}
exports.signedKeyPair = signedKeyPair

// ── AES-256-GCM ───────────────────────────────────────────────────────────────
function aesEncryptGCM(plaintext, key, iv, additionalData) {
	return Buffer.from(rb.aesEncryptGCM(plaintext, key, iv, additionalData))
}

function aesDecryptGCM(ciphertext, key, iv, additionalData) {
	return Buffer.from(rb.aesDecryptGCM(ciphertext, key, iv, additionalData))
}

// ── AES-256-CTR ───────────────────────────────────────────────────────────────
function aesEncryptCTR(plaintext, key, iv) {
	return Buffer.from(rb.aesEncryptCTR(plaintext, key, iv))
}

function aesDecryptCTR(ciphertext, key, iv) {
	return Buffer.from(rb.aesDecryptCTR(ciphertext, key, iv))
}

// ── AES-256-CBC ───────────────────────────────────────────────────────────────
function aesDecrypt(buffer, key) {
	return Buffer.from(rb.aesDecrypt(buffer, key))
}

function aesDecryptWithIV(buffer, key, IV) {
	return Buffer.from(rb.aesDecryptWithIV(buffer, key, IV))
}

function aesEncrypt(buffer, key) {
	return Buffer.from(rb.aesEncrypt(buffer, key))
}

function aesEncrypWithIV(buffer, key, IV) {
	return Buffer.from(rb.aesEncrypWithIV(buffer, key, IV))
}

// ── HMAC-SHA256 ───────────────────────────────────────────────────────────────
function hmacSign(buffer, key, variant = 'sha256') {
	if (variant !== 'sha256') {
		// fallback for non-SHA256 variants (rare edge case)
		const { createHmac } = require('crypto')
		return createHmac(variant, key).update(buffer).digest()
	}
	return Buffer.from(rb.hmacSign(buffer, key))
}

// ── SHA-256 ───────────────────────────────────────────────────────────────────
function sha256(buffer) {
	return Buffer.from(rb.sha256(buffer))
}

// ── PBKDF2 pairing code key ───────────────────────────────────────────────────
async function derivePairingCodeKey(pairingCode, salt) {
	const encoder = new TextEncoder()
	const pairingCodeBuffer = encoder.encode(pairingCode)
	const saltBuffer = new Uint8Array(salt instanceof Uint8Array ? salt : new Uint8Array(salt))
	const keyMaterial = await subtle.importKey('raw', pairingCodeBuffer, { name: 'PBKDF2' }, false, ['deriveBits'])
	const derivedBits = await subtle.deriveBits(
		{ name: 'PBKDF2', salt: saltBuffer, iterations: 600000, hash: 'SHA-256' },
		keyMaterial,
		256
	)
	return Buffer.from(derivedBits)
}
