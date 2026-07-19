'use strict'
Object.defineProperty(exports, '__esModule', { value: true })
exports.USyncDeviceProtocol = void 0
const WABinary_1 = require('../../WABinary')
class USyncDeviceProtocol {
	constructor() {
		this.name = 'devices'
	}
	getQueryElement() {
		return {
			tag: 'devices',
			attrs: {
				version: '2'
			}
		}
	}
	getUserElement(user) {
		const { deviceHash, ts, expectedTs } = user
		if (deviceHash == null && ts == null && expectedTs == null) {
			return null
		}
		const attrs = {}
		if (deviceHash != null) attrs.device_hash = deviceHash
		if (ts != null) attrs.ts = String(ts)
		if (expectedTs != null) attrs.expected_ts = String(expectedTs)
		return {
			tag: 'devices',
			attrs
		}
	}
	parser(node) {
		const deviceList = []
		let keyIndex = undefined
		if (node.tag === 'devices') {
			;(0, WABinary_1.assertNodeErrorFree)(node)
			const deviceListNode = (0, WABinary_1.getBinaryNodeChild)(node, 'device-list')
			const keyIndexNode = (0, WABinary_1.getBinaryNodeChild)(node, 'key-index-list')
			if (Array.isArray(deviceListNode?.content)) {
				for (const { tag, attrs } of deviceListNode.content) {
					const id = +attrs.id
					const keyIndex = +attrs['key-index']
					if (tag === 'device') {
						deviceList.push({
							id,
							keyIndex,
							isHosted: !!(attrs['is_hosted'] && attrs['is_hosted'] === 'true')
						})
					}
				}
			}
			if (keyIndexNode?.tag === 'key-index-list') {
				keyIndex = {
					timestamp: +keyIndexNode.attrs['ts'],
					signedKeyIndex: keyIndexNode?.content,
					expectedTimestamp: keyIndexNode.attrs['expected_ts'] ? +keyIndexNode.attrs['expected_ts'] : undefined
				}
			}
		}
		return {
			deviceList,
			keyIndex
		}
	}
}
exports.USyncDeviceProtocol = USyncDeviceProtocol
