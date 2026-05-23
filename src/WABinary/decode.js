'use strict'
var __createBinding =
	(this && this.__createBinding) ||
	(Object.create
		? function (o, m, k, k2) {
				if (k2 === undefined) k2 = k
				var desc = Object.getOwnPropertyDescriptor(m, k)
				if (!desc || ('get' in desc ? !m.__esModule : desc.writable || desc.configurable)) {
					desc = {
						enumerable: true,
						get: function () {
							return m[k]
						}
					}
				}
				Object.defineProperty(o, k2, desc)
			}
		: function (o, m, k, k2) {
				if (k2 === undefined) k2 = k
				o[k2] = m[k]
			})
var __setModuleDefault =
	(this && this.__setModuleDefault) ||
	(Object.create
		? function (o, v) {
				Object.defineProperty(o, 'default', { enumerable: true, value: v })
			}
		: function (o, v) {
				o['default'] = v
			})
var __importStar =
	(this && this.__importStar) ||
	(function () {
		var ownKeys = function (o) {
			ownKeys =
				Object.getOwnPropertyNames ||
				function (o) {
					var ar = []
					for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k
					return ar
				}
			return ownKeys(o)
		}
		return function (mod) {
			if (mod && mod.__esModule) return mod
			var result = {}
			if (mod != null)
				for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== 'default') __createBinding(result, mod, k[i])
			__setModuleDefault(result, mod)
			return result
		}
	})()
Object.defineProperty(exports, '__esModule', { value: true })
exports.decodeBinaryNode = exports.decodeDecompressedBinaryNode = exports.decompressingIfRequired = void 0
const util_1 = require('util')
const zlib_1 = require('zlib')
const constants = __importStar(require('./constants'))
const jid_utils_1 = require('./jid-utils')
const rb = require('whatsapp-rust-bridge')
const inflatePromise = (0, util_1.promisify)(zlib_1.inflate)
const decompressingIfRequired = async buffer => {
	if (2 & buffer.readUInt8()) {
		buffer = await inflatePromise(buffer.slice(1))
	} else {
		// nodes with no compression have a 0x00 prefix, we remove that
		buffer = buffer.slice(1)
	}
	return buffer
}
exports.decompressingIfRequired = decompressingIfRequired

// Converts InternalBinaryNode.toJSON() output to a plain JS object with Buffer content
const rustNodeToJs = node => {
	if (!node || typeof node !== 'object') return node
	const result = { tag: node.tag, attrs: node.attrs || {} }
	const content = node.content
	if (content === undefined || content === null) {
		// no content
	} else if (content instanceof Uint8Array) {
		result.content = Buffer.from(content)
	} else if (typeof content === 'string') {
		result.content = content
	} else if (Array.isArray(content)) {
		result.content = content.map(rustNodeToJs)
	} else {
		result.content = content
	}
	return result
}
const decodeDecompressedBinaryNode = (buffer, opts, indexRef = { index: 0 }) => {
	const { DOUBLE_BYTE_TOKENS, SINGLE_BYTE_TOKENS, TAGS } = opts
	const checkEOS = length => {
		if (indexRef.index + length > buffer.length) {
			throw new Error('end of stream')
		}
	}
	const next = () => {
		const value = buffer[indexRef.index]
		indexRef.index += 1
		return value
	}
	const readByte = () => {
		checkEOS(1)
		return next()
	}
	const readBytes = n => {
		checkEOS(n)
		const value = buffer.slice(indexRef.index, indexRef.index + n)
		indexRef.index += n
		return value
	}
	const readStringFromChars = length => {
		return readBytes(length).toString('utf-8')
	}
	const readInt = (n, littleEndian = false) => {
		checkEOS(n)
		let val = 0
		for (let i = 0; i < n; i++) {
			const shift = littleEndian ? i : n - 1 - i
			val |= next() << (shift * 8)
		}
		return val
	}
	const readInt20 = () => {
		checkEOS(3)
		return ((next() & 15) << 16) + (next() << 8) + next()
	}
	const unpackHex = value => {
		if (value >= 0 && value < 16) {
			return value < 10 ? '0'.charCodeAt(0) + value : 'A'.charCodeAt(0) + value - 10
		}
		throw new Error('invalid hex: ' + value)
	}
	const unpackNibble = value => {
		if (value >= 0 && value <= 9) {
			return '0'.charCodeAt(0) + value
		}
		switch (value) {
			case 10:
				return '-'.charCodeAt(0)
			case 11:
				return '.'.charCodeAt(0)
			case 15:
				return '\0'.charCodeAt(0)
			default:
				throw new Error('invalid nibble: ' + value)
		}
	}
	const unpackByte = (tag, value) => {
		if (tag === TAGS.NIBBLE_8) {
			return unpackNibble(value)
		} else if (tag === TAGS.HEX_8) {
			return unpackHex(value)
		} else {
			throw new Error('unknown tag: ' + tag)
		}
	}
	const readPacked8 = tag => {
		const startByte = readByte()
		let value = ''
		for (let i = 0; i < (startByte & 127); i++) {
			const curByte = readByte()
			value += String.fromCharCode(unpackByte(tag, (curByte & 0xf0) >> 4))
			value += String.fromCharCode(unpackByte(tag, curByte & 0x0f))
		}
		if (startByte >> 7 !== 0) {
			value = value.slice(0, -1)
		}
		return value
	}
	const isListTag = tag => {
		return tag === TAGS.LIST_EMPTY || tag === TAGS.LIST_8 || tag === TAGS.LIST_16
	}
	const readListSize = tag => {
		switch (tag) {
			case TAGS.LIST_EMPTY:
				return 0
			case TAGS.LIST_8:
				return readByte()
			case TAGS.LIST_16:
				return readInt(2)
			default:
				throw new Error('invalid tag for list size: ' + tag)
		}
	}
	const readJidPair = () => {
		const i = readString(readByte())
		const j = readString(readByte())
		if (j) {
			return (i || '') + '@' + j
		}
		throw new Error('invalid jid pair: ' + i + ', ' + j)
	}
	const readAdJid = () => {
		const rawDomainType = readByte()
		const domainType = Number(rawDomainType)
		const device = readByte()
		const user = readString(readByte())
		let server = 's.whatsapp.net' // default whatsapp server
		if (domainType === jid_utils_1.WAJIDDomains.LID) {
			server = 'lid'
		} else if (domainType === jid_utils_1.WAJIDDomains.HOSTED) {
			server = 'hosted'
		} else if (domainType === jid_utils_1.WAJIDDomains.HOSTED_LID) {
			server = 'hosted.lid'
		}
		return (0, jid_utils_1.jidEncode)(user, server, device)
	}
	const readFbJid = () => {
		const user = readString(readByte())
		const device = readInt(2)
		const server = readString(readByte())
		return `${user}:${device}@${server}`
	}
	const readInteropJid = () => {
		const user = readString(readByte())
		const device = readInt(2)
		const integrator = readInt(2)
		let server = 'interop'
		const beforeServer = indexRef.index
		try {
			server = readString(readByte())
		} catch (err) {
			indexRef.index = beforeServer
		}
		return `${integrator}-${user}:${device}@${server}`
	}
	const readInteropJidTuple = () => {
		const user = readString(readByte())
		const device = readInt(2)
		const integrator = readInt(2)
		const domain = readByte()
		if (domain !== 0) {
			throw new Error(`invalid domain for INTEROP_JID_TUPLE: ${domain}`)
		}
		const devicePart = device !== 0 ? `:${device}` : ''
		return `${integrator}-${user}${devicePart}@interop`
	}
	const readString = tag => {
		if (tag >= 1 && tag < SINGLE_BYTE_TOKENS.length) {
			return SINGLE_BYTE_TOKENS[tag] || ''
		}
		switch (tag) {
			case TAGS.DICTIONARY_0:
			case TAGS.DICTIONARY_1:
			case TAGS.DICTIONARY_2:
			case TAGS.DICTIONARY_3:
				return getTokenDouble(tag - TAGS.DICTIONARY_0, readByte())
			case TAGS.LIST_EMPTY:
				return ''
			case TAGS.BINARY_8:
				return readStringFromChars(readByte())
			case TAGS.BINARY_20:
				return readStringFromChars(readInt20())
			case TAGS.BINARY_32:
				return readStringFromChars(readInt(4))
			case TAGS.JID_PAIR:
				return readJidPair()
			case TAGS.FB_JID:
				return readFbJid()
			case TAGS.INTEROP_JID_TUPLE:
				return readInteropJidTuple()
			case TAGS.INTEROP_JID:
				return readInteropJid()
			case TAGS.AD_JID:
				return readAdJid()
			case TAGS.HEX_8:
			case TAGS.NIBBLE_8:
				return readPacked8(tag)
			default:
				// Unknown tag — token table may be outdated (new WA protocol version)
				process.stderr.write(`[WABinary] unknown string tag 0x${tag.toString(16)} — token table outdated?\n`)
				return ''
		}
	}
	const readList = tag => {
		const items = []
		const size = readListSize(tag)
		for (let i = 0; i < size; i++) {
			items.push((0, exports.decodeDecompressedBinaryNode)(buffer, opts, indexRef))
		}
		return items
	}
	const getTokenDouble = (index1, index2) => {
		const dict = DOUBLE_BYTE_TOKENS[index1]
		if (!dict) {
			// Unknown dictionary — token table may be outdated (new WA protocol version)
			process.stderr.write(`[WABinary] unknown double-byte token dict ${index1} — token table outdated?\n`)
			return ''
		}
		const value = dict[index2]
		if (typeof value === 'undefined') {
			// Unknown token in known dictionary — token table may be outdated
			process.stderr.write(`[WABinary] unknown double-byte token dict=${index1} idx=${index2} — token table outdated?\n`)
			return ''
		}
		return value
	}
	const listSize = readListSize(readByte())
	const header = readString(readByte())
	if (!listSize || !header.length) {
		throw new Error('invalid node')
	}
	const attrs = {}
	let data
	if (listSize === 0 || !header) {
		throw new Error('invalid node')
	}
	// read the attributes in
	const attributesLength = (listSize - 1) >> 1
	for (let i = 0; i < attributesLength; i++) {
		const key = readString(readByte())
		const value = readString(readByte())
		attrs[key] = value
	}
	if (listSize % 2 === 0) {
		const tag = readByte()
		if (isListTag(tag)) {
			data = readList(tag)
		} else {
			let decoded
			switch (tag) {
				case TAGS.BINARY_8:
					decoded = readBytes(readByte())
					break
				case TAGS.BINARY_20:
					decoded = readBytes(readInt20())
					break
				case TAGS.BINARY_32:
					decoded = readBytes(readInt(4))
					break
				default:
					decoded = readString(tag)
					break
			}
			data = decoded
		}
	}
	return {
		tag: header,
		attrs,
		content: data
	}
}
exports.decodeDecompressedBinaryNode = decodeDecompressedBinaryNode
const decodeBinaryNode = buff => {
	const u8 = buff instanceof Uint8Array ? buff : new Uint8Array(buff.buffer, buff.byteOffset, buff.byteLength)
	const internal = rb.decodeNode(u8)
	return rustNodeToJs(internal.toJSON())
}
exports.decodeBinaryNode = decodeBinaryNode
