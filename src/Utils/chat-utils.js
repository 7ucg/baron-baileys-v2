'use strict'
Object.defineProperty(exports, '__esModule', { value: true })
exports.processSyncAction =
	exports.chatModificationToAppPatch =
	exports.decodePatches =
	exports.decodeSyncdSnapshot =
	exports.downloadExternalPatch =
	exports.downloadExternalBlob =
	exports.extractSyncdPatches =
	exports.decodeSyncdPatch =
	exports.decodeSyncdMutations =
	exports.encodeSyncdPatch =
	exports.newLTHashState =
		void 0
const boom_1 = require('@hapi/boom')
const whatsapp_rust_bridge_1 = require('whatsapp-rust-bridge-baron')
const index_js_1 = require('../../WAProto/index.js')
const LabelAssociation_1 = require('../Types/LabelAssociation')
const WABinary_1 = require('../WABinary')
const crypto_1 = require('./crypto')
const generics_1 = require('./generics')
const lt_hash_1 = require('./lt-hash')
const messages_media_1 = require('./messages-media')
const sync_action_utils_1 = require('./sync-action-utils')
const mutationKeys = keydata => {
	const keys = (0, whatsapp_rust_bridge_1.expandAppStateKeys)(keydata)
	return {
		indexKey: keys.indexKey,
		valueEncryptionKey: keys.valueEncryptionKey,
		valueMacKey: keys.valueMacKey,
		snapshotMacKey: keys.snapshotMacKey,
		patchMacKey: keys.patchMacKey
	}
}
const generateMac = (operation, data, keyId, key) => {
	const opByte = operation === index_js_1.proto.SyncdMutation.SyncdOperation.SET ? 0x01 : 0x02
	const keyIdBuffer = typeof keyId === 'string' ? Buffer.from(keyId, 'base64') : keyId
	const keyData = new Uint8Array(1 + keyIdBuffer.length)
	keyData[0] = opByte
	keyData.set(keyIdBuffer, 1)
	const last = new Uint8Array(8)
	last[7] = keyData.length
	const total = new Uint8Array(keyData.length + data.length + last.length)
	total.set(keyData, 0)
	total.set(data, keyData.length)
	total.set(last, keyData.length + data.length)
	const hmac = (0, crypto_1.hmacSign)(total, key, 'sha512')
	return hmac.subarray(0, 32)
}
const to64BitNetworkOrder = e => {
	const buff = Buffer.alloc(8)
	buff.writeUint32BE(e, 4)
	return buff
}
const makeLtHashGenerator = ({ indexValueMap, hash }) => {
	indexValueMap = { ...indexValueMap }
	const addBuffs = []
	const subBuffs = []
	return {
		mix: ({ indexMac, valueMac, operation }) => {
			const indexMacBase64 = Buffer.from(indexMac).toString('base64')
			const prevOp = indexValueMap[indexMacBase64]
			if (operation === index_js_1.proto.SyncdMutation.SyncdOperation.REMOVE) {
				if (!prevOp) {
					throw new boom_1.Boom('tried remove, but no previous op', { data: { indexMac, valueMac } })
				}
				// remove from index value mac, since this mutation is erased
				delete indexValueMap[indexMacBase64]
			} else {
				addBuffs.push(valueMac)
				// add this index into the history map
				indexValueMap[indexMacBase64] = { valueMac }
			}
			if (prevOp) {
				subBuffs.push(prevOp.valueMac)
			}
		},
		finish: () => {
			const result = lt_hash_1.LT_HASH_ANTI_TAMPERING.subtractThenAdd(hash, subBuffs, addBuffs)
			return {
				hash: Buffer.from(result),
				indexValueMap
			}
		}
	}
}
const generateSnapshotMac = (lthash, version, name, key) => {
	const total = Buffer.concat([lthash, to64BitNetworkOrder(version), Buffer.from(name, 'utf-8')])
	return (0, crypto_1.hmacSign)(total, key, 'sha256')
}
const generatePatchMac = (snapshotMac, valueMacs, version, type, key) => {
	const total = Buffer.concat([snapshotMac, ...valueMacs, to64BitNetworkOrder(version), Buffer.from(type, 'utf-8')])
	return (0, crypto_1.hmacSign)(total, key)
}
const newLTHashState = () => ({ version: 0, hash: Buffer.alloc(128), indexValueMap: {} })
exports.newLTHashState = newLTHashState
exports.makeLtHashGenerator = makeLtHashGenerator
const ensureLTHashStateVersion = state => {
	if (typeof state.version !== 'number' || isNaN(state.version)) {
		state.version = 0
	}
	return state
}
exports.ensureLTHashStateVersion = ensureLTHashStateVersion
exports.MAX_SYNC_ATTEMPTS = 2
const isMissingKeyError = error => {
	return error?.data?.isMissingKey === true
}
exports.isMissingKeyError = isMissingKeyError
const isAppStateSyncIrrecoverable = (error, attempts) => {
	return attempts >= exports.MAX_SYNC_ATTEMPTS || error?.name === 'TypeError'
}
exports.isAppStateSyncIrrecoverable = isAppStateSyncIrrecoverable
const encodeSyncdPatch = async (
	{ type, index, syncAction, apiVersion, operation },
	myAppStateKeyId,
	state,
	getAppStateSyncKey
) => {
	const key = !!myAppStateKeyId ? await getAppStateSyncKey(myAppStateKeyId) : undefined
	if (!key) {
		throw new boom_1.Boom(`myAppStateKey ("${myAppStateKeyId}") not present`, { statusCode: 404 })
	}
	const encKeyId = Buffer.from(myAppStateKeyId, 'base64')
	state = { ...state, indexValueMap: { ...state.indexValueMap } }
	const indexBuffer = Buffer.from(JSON.stringify(index))
	const dataProto = index_js_1.proto.SyncActionData.fromObject({
		index: indexBuffer,
		value: syncAction,
		padding: new Uint8Array(0),
		version: apiVersion
	})
	const encoded = index_js_1.proto.SyncActionData.encode(dataProto).finish()
	const keyValue = mutationKeys(key.keyData)
	const encValue = (0, crypto_1.aesEncrypt)(encoded, keyValue.valueEncryptionKey)
	const valueMac = generateMac(operation, encValue, encKeyId, keyValue.valueMacKey)
	const indexMac = (0, crypto_1.hmacSign)(indexBuffer, keyValue.indexKey)
	// update LT hash
	const generator = makeLtHashGenerator(state)
	generator.mix({ indexMac, valueMac, operation })
	Object.assign(state, generator.finish())
	state.version += 1
	const snapshotMac = generateSnapshotMac(state.hash, state.version, type, keyValue.snapshotMacKey)
	const patch = {
		patchMac: generatePatchMac(snapshotMac, [valueMac], state.version, type, keyValue.patchMacKey),
		snapshotMac: snapshotMac,
		keyId: { id: encKeyId },
		mutations: [
			{
				operation: operation,
				record: {
					index: {
						blob: indexMac
					},
					value: {
						blob: Buffer.concat([encValue, valueMac])
					},
					keyId: { id: encKeyId }
				}
			}
		]
	}
	const base64Index = indexMac.toString('base64')
	state.indexValueMap[base64Index] = { valueMac }
	return { patch, state }
}
exports.encodeSyncdPatch = encodeSyncdPatch
const decodeSyncdMutations = async (msgMutations, initialState, getAppStateSyncKey, onMutation, validateMacs) => {
	const ltGenerator = makeLtHashGenerator(initialState)
	const derivedKeyCache = new Map()
	// indexKey used to HMAC sign record.index.blob
	// valueEncryptionKey used to AES-256-CBC encrypt record.value.blob[0:-32]
	// the remaining record.value.blob[0:-32] is the mac, it the HMAC sign of key.keyId + decoded proto data + length of bytes in keyId
	for (const msgMutation of msgMutations) {
		// if it's a syncdmutation, get the operation property
		// otherwise, if it's only a record -- it'll be a SET mutation
		const operation =
			'operation' in msgMutation ? msgMutation.operation : index_js_1.proto.SyncdMutation.SyncdOperation.SET
		const record = 'record' in msgMutation && !!msgMutation.record ? msgMutation.record : msgMutation
		const key = await getKey(record.keyId.id)
		const content = record.value.blob
		const encContent = content.subarray(0, -32)
		const ogValueMac = content.subarray(-32)
		if (validateMacs) {
			const contentHmac = generateMac(operation, encContent, record.keyId.id, key.valueMacKey)
			if (Buffer.compare(contentHmac, ogValueMac) !== 0) {
				throw new boom_1.Boom('HMAC content verification failed')
			}
		}
		const result = (0, crypto_1.aesDecrypt)(encContent, key.valueEncryptionKey)
		const syncAction = index_js_1.proto.SyncActionData.decode(result)
		if (validateMacs) {
			const hmac = (0, crypto_1.hmacSign)(syncAction.index, key.indexKey)
			if (Buffer.compare(hmac, record.index.blob) !== 0) {
				throw new boom_1.Boom('HMAC index verification failed')
			}
		}
		const indexStr = Buffer.from(syncAction.index).toString()
		onMutation({ syncAction, index: JSON.parse(indexStr) })
		ltGenerator.mix({
			indexMac: record.index.blob,
			valueMac: ogValueMac,
			operation: operation
		})
	}
	return ltGenerator.finish()
	async function getKey(keyId) {
		const base64Key = Buffer.from(keyId).toString('base64')
		const cached = derivedKeyCache.get(base64Key)
		if (cached) {
			return cached
		}
		const keyEnc = await getAppStateSyncKey(base64Key)
		if (!keyEnc) {
			throw new boom_1.Boom(`failed to find key "${base64Key}" to decode mutation`, {
				statusCode: 404,
				data: { msgMutations }
			})
		}
		const keys = mutationKeys(keyEnc.keyData)
		derivedKeyCache.set(base64Key, keys)
		return keys
	}
}
exports.decodeSyncdMutations = decodeSyncdMutations
const decodeSyncdPatch = async (msg, name, initialState, getAppStateSyncKey, onMutation, validateMacs) => {
	if (validateMacs) {
		const base64Key = Buffer.from(msg.keyId.id).toString('base64')
		const mainKeyObj = await getAppStateSyncKey(base64Key)
		if (!mainKeyObj) {
			throw new boom_1.Boom(`failed to find key "${base64Key}" to decode patch`, { statusCode: 404, data: { msg } })
		}
		const mainKey = mutationKeys(mainKeyObj.keyData)
		const mutationmacs = msg.mutations.map(mutation => mutation.record.value.blob.slice(-32))
		const patchMac = generatePatchMac(
			msg.snapshotMac,
			mutationmacs,
			(0, generics_1.toNumber)(msg.version.version),
			name,
			mainKey.patchMacKey
		)
		if (Buffer.compare(patchMac, msg.patchMac) !== 0) {
			throw new boom_1.Boom('Invalid patch mac')
		}
	}
	const result = await (0, exports.decodeSyncdMutations)(
		msg.mutations,
		initialState,
		getAppStateSyncKey,
		onMutation,
		validateMacs
	)
	return result
}
exports.decodeSyncdPatch = decodeSyncdPatch
const extractSyncdPatches = async (result, options) => {
	const syncNode = (0, WABinary_1.getBinaryNodeChild)(result, 'sync')
	const collectionNodes = (0, WABinary_1.getBinaryNodeChildren)(syncNode, 'collection')
	const final = {}
	await Promise.all(
		collectionNodes.map(async collectionNode => {
			const patchesNode = (0, WABinary_1.getBinaryNodeChild)(collectionNode, 'patches')
			const patches = (0, WABinary_1.getBinaryNodeChildren)(patchesNode || collectionNode, 'patch')
			const snapshotNode = (0, WABinary_1.getBinaryNodeChild)(collectionNode, 'snapshot')
			const syncds = []
			const name = collectionNode.attrs.name
			const hasMorePatches = collectionNode.attrs.has_more_patches === 'true'
			let snapshot = undefined
			if (snapshotNode && !!snapshotNode.content) {
				if (!Buffer.isBuffer(snapshotNode)) {
					snapshotNode.content = Buffer.from(Object.values(snapshotNode.content))
				}
				const blobRef = index_js_1.proto.ExternalBlobReference.decode(snapshotNode.content)
				const data = await (0, exports.downloadExternalBlob)(blobRef, options)
				snapshot = index_js_1.proto.SyncdSnapshot.decode(data)
			}
			for (let { content } of patches) {
				if (content) {
					if (!Buffer.isBuffer(content)) {
						content = Buffer.from(Object.values(content))
					}
					const syncd = index_js_1.proto.SyncdPatch.decode(content)
					if (!syncd.version) {
						syncd.version = { version: +collectionNode.attrs.version + 1 }
					}
					syncds.push(syncd)
				}
			}
			final[name] = { patches: syncds, hasMorePatches, snapshot }
		})
	)
	return final
}
exports.extractSyncdPatches = extractSyncdPatches
const downloadExternalBlob = async (blob, options) => {
	const stream = await (0, messages_media_1.downloadContentFromMessage)(blob, 'md-app-state', { options })
	const bufferArray = []
	for await (const chunk of stream) {
		bufferArray.push(chunk)
	}
	return Buffer.concat(bufferArray)
}
exports.downloadExternalBlob = downloadExternalBlob
const downloadExternalPatch = async (blob, options) => {
	const buffer = await (0, exports.downloadExternalBlob)(blob, options)
	const syncData = index_js_1.proto.SyncdMutations.decode(buffer)
	return syncData
}
exports.downloadExternalPatch = downloadExternalPatch
const decodeSyncdSnapshot = async (name, snapshot, getAppStateSyncKey, minimumVersionNumber, validateMacs = true) => {
	const newState = (0, exports.newLTHashState)()
	newState.version = (0, generics_1.toNumber)(snapshot.version.version)
	const mutationMap = {}
	const areMutationsRequired = typeof minimumVersionNumber === 'undefined' || newState.version > minimumVersionNumber
	const { hash, indexValueMap } = await (0, exports.decodeSyncdMutations)(
		snapshot.records,
		newState,
		getAppStateSyncKey,
		areMutationsRequired
			? mutation => {
					const index = mutation.syncAction.index?.toString()
					mutationMap[index] = mutation
				}
			: () => {},
		validateMacs
	)
	newState.hash = hash
	newState.indexValueMap = indexValueMap
	if (validateMacs) {
		const base64Key = Buffer.from(snapshot.keyId.id).toString('base64')
		const keyEnc = await getAppStateSyncKey(base64Key)
		if (!keyEnc) {
			throw new boom_1.Boom(`failed to find key "${base64Key}" to decode mutation`)
		}
		const result = mutationKeys(keyEnc.keyData)
		const computedSnapshotMac = generateSnapshotMac(newState.hash, newState.version, name, result.snapshotMacKey)
		if (Buffer.compare(snapshot.mac, computedSnapshotMac) !== 0) {
			throw new boom_1.Boom(`failed to verify LTHash at ${newState.version} of ${name} from snapshot`)
		}
	}
	return {
		state: newState,
		mutationMap
	}
}
exports.decodeSyncdSnapshot = decodeSyncdSnapshot
const decodePatches = async (
	name,
	syncds,
	initial,
	getAppStateSyncKey,
	options,
	minimumVersionNumber,
	logger,
	validateMacs = true
) => {
	const newState = {
		...initial,
		indexValueMap: { ...initial.indexValueMap }
	}
	const mutationMap = {}
	for (const syncd of syncds) {
		const { version, keyId, snapshotMac } = syncd
		if (syncd.externalMutations) {
			logger?.trace({ name, version }, 'downloading external patch')
			const ref = await (0, exports.downloadExternalPatch)(syncd.externalMutations, options)
			logger?.debug({ name, version, mutations: ref.mutations.length }, 'downloaded external patch')
			syncd.mutations?.push(...ref.mutations)
		}
		const patchVersion = (0, generics_1.toNumber)(version.version)
		newState.version = patchVersion
		const shouldMutate = typeof minimumVersionNumber === 'undefined' || patchVersion > minimumVersionNumber
		const decodeResult = await (0, exports.decodeSyncdPatch)(
			syncd,
			name,
			newState,
			getAppStateSyncKey,
			shouldMutate
				? mutation => {
						const index = mutation.syncAction.index?.toString()
						mutationMap[index] = mutation
					}
				: () => {},
			true
		)
		newState.hash = decodeResult.hash
		newState.indexValueMap = decodeResult.indexValueMap
		if (validateMacs) {
			const base64Key = Buffer.from(keyId.id).toString('base64')
			const keyEnc = await getAppStateSyncKey(base64Key)
			if (!keyEnc) {
				throw new boom_1.Boom(`failed to find key "${base64Key}" to decode mutation`)
			}
			const result = mutationKeys(keyEnc.keyData)
			const computedSnapshotMac = generateSnapshotMac(newState.hash, newState.version, name, result.snapshotMacKey)
			if (Buffer.compare(snapshotMac, computedSnapshotMac) !== 0) {
				throw new boom_1.Boom(`failed to verify LTHash at ${newState.version} of ${name}`)
			}
		}
		// clear memory used up by the mutations
		syncd.mutations = []
	}
	return { state: newState, mutationMap }
}
exports.decodePatches = decodePatches
const chatModificationToAppPatch = (mod, jid) => {
	const OP = index_js_1.proto.SyncdMutation.SyncdOperation
	const getMessageRange = lastMessages => {
		let messageRange
		if (Array.isArray(lastMessages)) {
			const lastMsg = lastMessages[lastMessages.length - 1]
			messageRange = {
				lastMessageTimestamp: lastMsg?.messageTimestamp,
				messages: lastMessages?.length
					? lastMessages.map(m => {
							if (!m.key?.id || !m.key?.remoteJid) {
								throw new boom_1.Boom('Incomplete key', { statusCode: 400, data: m })
							}
							if ((0, WABinary_1.isJidGroup)(m.key.remoteJid) && !m.key.fromMe && !m.key.participant) {
								throw new boom_1.Boom('Expected not from me message to have participant', { statusCode: 400, data: m })
							}
							if (!m.messageTimestamp || !(0, generics_1.toNumber)(m.messageTimestamp)) {
								throw new boom_1.Boom('Missing timestamp in last message list', { statusCode: 400, data: m })
							}
							if (m.key.participant) {
								m.key.participant = (0, WABinary_1.jidNormalizedUser)(m.key.participant)
							}
							return m
						})
					: undefined
			}
		} else {
			messageRange = lastMessages
		}
		return messageRange
	}
	let patch
	if ('mute' in mod) {
		patch = {
			syncAction: {
				muteAction: {
					muted: !!mod.mute,
					muteEndTimestamp: mod.mute || undefined
				}
			},
			index: ['mute', jid],
			type: 'regular_high',
			apiVersion: 2,
			operation: OP.SET
		}
	} else if ('archive' in mod) {
		patch = {
			syncAction: {
				archiveChatAction: {
					archived: !!mod.archive,
					messageRange: getMessageRange(mod.lastMessages)
				}
			},
			index: ['archive', jid],
			type: 'regular_low',
			apiVersion: 3,
			operation: OP.SET
		}
	} else if ('markRead' in mod) {
		patch = {
			syncAction: {
				markChatAsReadAction: {
					read: mod.markRead,
					messageRange: getMessageRange(mod.lastMessages)
				}
			},
			index: ['markChatAsRead', jid],
			type: 'regular_low',
			apiVersion: 3,
			operation: OP.SET
		}
	} else if ('deleteForMe' in mod) {
		const { timestamp, key, deleteMedia } = mod.deleteForMe
		patch = {
			syncAction: {
				deleteMessageForMeAction: {
					deleteMedia,
					messageTimestamp: timestamp
				}
			},
			index: ['deleteMessageForMe', jid, key.id, key.fromMe ? '1' : '0', '0'],
			type: 'regular_high',
			apiVersion: 3,
			operation: OP.SET
		}
	} else if ('clear' in mod) {
		patch = {
			syncAction: {
				clearChatAction: {
					messageRange: getMessageRange(mod.lastMessages)
				}
			},
			index: ['clearChat', jid, '1' /*the option here is 0 when keep starred messages is enabled*/, '0'],
			type: 'regular_high',
			apiVersion: 6,
			operation: OP.SET
		}
	} else if ('pin' in mod) {
		patch = {
			syncAction: {
				pinAction: {
					pinned: !!mod.pin
				}
			},
			index: ['pin_v1', jid],
			type: 'regular_low',
			apiVersion: 5,
			operation: OP.SET
		}
	} else if ('contact' in mod) {
		patch = {
			syncAction: {
				contactAction: mod.contact || {}
			},
			index: ['contact', jid],
			type: 'critical_unblock_low',
			apiVersion: 2,
			operation: mod.contact ? OP.SET : OP.REMOVE
		}
	} else if ('disableLinkPreviews' in mod) {
		patch = {
			syncAction: {
				privacySettingDisableLinkPreviewsAction: mod.disableLinkPreviews || {}
			},
			index: ['setting_disableLinkPreviews'],
			type: 'regular',
			apiVersion: 8,
			operation: OP.SET
		}
	} else if ('star' in mod) {
		const key = mod.star.messages[0]
		patch = {
			syncAction: {
				starAction: {
					starred: !!mod.star.star
				}
			},
			index: ['star', jid, key.id, key.fromMe ? '1' : '0', '0'],
			type: 'regular_low',
			apiVersion: 2,
			operation: OP.SET
		}
	} else if ('delete' in mod) {
		patch = {
			syncAction: {
				deleteChatAction: {
					messageRange: getMessageRange(mod.lastMessages)
				}
			},
			index: ['deleteChat', jid, '1'],
			type: 'regular_high',
			apiVersion: 6,
			operation: OP.SET
		}
	} else if ('pushNameSetting' in mod) {
		patch = {
			syncAction: {
				pushNameSetting: {
					name: mod.pushNameSetting
				}
			},
			index: ['setting_pushName'],
			type: 'critical_block',
			apiVersion: 1,
			operation: OP.SET
		}
	} else if ('quickReply' in mod) {
		patch = {
			syncAction: {
				quickReplyAction: {
					count: 0,
					deleted: mod.quickReply.deleted || false,
					keywords: [],
					message: mod.quickReply.message || '',
					shortcut: mod.quickReply.shortcut || ''
				}
			},
			index: ['quick_reply', mod.quickReply.timestamp || String(Math.floor(Date.now() / 1000))],
			type: 'regular',
			apiVersion: 2,
			operation: OP.SET
		}
	} else if ('addLabel' in mod) {
		patch = {
			syncAction: {
				labelEditAction: {
					name: mod.addLabel.name,
					color: mod.addLabel.color,
					predefinedId: mod.addLabel.predefinedId,
					deleted: mod.addLabel.deleted
				}
			},
			index: ['label_edit', mod.addLabel.id],
			type: 'regular',
			apiVersion: 3,
			operation: OP.SET
		}
	} else if ('addChatLabel' in mod) {
		patch = {
			syncAction: {
				labelAssociationAction: {
					labeled: true
				}
			},
			index: [LabelAssociation_1.LabelAssociationType.Chat, mod.addChatLabel.labelId, jid],
			type: 'regular',
			apiVersion: 3,
			operation: OP.SET
		}
	} else if ('removeChatLabel' in mod) {
		patch = {
			syncAction: {
				labelAssociationAction: {
					labeled: false
				}
			},
			index: [LabelAssociation_1.LabelAssociationType.Chat, mod.removeChatLabel.labelId, jid],
			type: 'regular',
			apiVersion: 3,
			operation: OP.SET
		}
	} else if ('addMessageLabel' in mod) {
		patch = {
			syncAction: {
				labelAssociationAction: {
					labeled: true
				}
			},
			index: [
				LabelAssociation_1.LabelAssociationType.Message,
				mod.addMessageLabel.labelId,
				jid,
				mod.addMessageLabel.messageId,
				'0',
				'0'
			],
			type: 'regular',
			apiVersion: 3,
			operation: OP.SET
		}
	} else if ('removeMessageLabel' in mod) {
		patch = {
			syncAction: {
				labelAssociationAction: {
					labeled: false
				}
			},
			index: [
				LabelAssociation_1.LabelAssociationType.Message,
				mod.removeMessageLabel.labelId,
				jid,
				mod.removeMessageLabel.messageId,
				'0',
				'0'
			],
			type: 'regular',
			apiVersion: 3,
			operation: OP.SET
		}
	} else if ('markAsUnread' in mod) {
		patch = {
			syncAction: {
				markChatAsReadAction: {
					read: false,
					messageRange: getMessageRange(mod.lastMessages)
				}
			},
			index: ['markChatAsRead', jid],
			type: 'regular_low',
			apiVersion: 3,
			operation: OP.SET
		}
	} else if ('setChatEphemeral' in mod) {
		const duration =
			typeof mod.setChatEphemeral === 'number' ? mod.setChatEphemeral : (mod.setChatEphemeral?.duration ?? 0)
		patch = {
			syncAction: {
				chatEphemeralAction: {
					ephemeralExpiration: duration,
					ephemeralSettingTimestamp: Date.now()
				}
			},
			index: ['ephemeral', jid],
			type: 'regular',
			apiVersion: 1,
			operation: OP.SET
		}
	} else if ('silenceChat' in mod) {
		patch = {
			syncAction: {
				muteAction: {
					muted: mod.silenceChat.silent !== false,
					muteEndTimestamp: mod.silenceChat.until ?? null
				}
			},
			index: ['mute', jid],
			type: 'regular_high',
			apiVersion: 2,
			operation: OP.SET
		}
	} else if ('muteStatus' in mod) {
		patch = {
			syncAction: {
				userStatusMuteAction: { muted: mod.muteStatus.muted !== false }
			},
			index: ['user_status_mute', jid],
			type: 'regular',
			apiVersion: 1,
			operation: OP.SET
		}
	} else if ('favorite' in mod) {
		patch = {
			syncAction: {
				favoritesAction: { isFavorite: !!mod.favorite.isFavorite }
			},
			index: ['favorites', jid],
			type: 'regular',
			apiVersion: 1,
			operation: OP.SET
		}
	} else if ('reorderLabel' in mod) {
		patch = {
			syncAction: {
				labelReorderingAction: { sortedLabelIds: mod.reorderLabel.sortedLabelIds || [] }
			},
			index: ['label_reordering'],
			type: 'regular',
			apiVersion: 1,
			operation: OP.SET
		}
	} else if ('deleteCallLog' in mod) {
		patch = {
			syncAction: {
				deleteIndividualCallLog: { callId: mod.deleteCallLog.callId || mod.deleteCallLog }
			},
			index: ['delete_call_log', jid],
			type: 'regular',
			apiVersion: 1,
			operation: OP.SET
		}
	} else if ('noteEdit' in mod) {
		patch = {
			syncAction: {
				noteEditAction: { note: mod.noteEdit.note || mod.noteEdit, deleted: mod.noteEdit.deleted ?? false }
			},
			index: ['note_edit', jid],
			type: 'regular',
			apiVersion: 1,
			operation: OP.SET
		}
	} else if ('aiThreadRename' in mod) {
		patch = {
			syncAction: {
				aiThreadRenameAction: {
					newTitle: mod.aiThreadRename.title || mod.aiThreadRename
				}
			},
			index: ['ai_thread_rename', jid],
			type: 'regular_high',
			apiVersion: 1,
			operation: OP.SET
		}
	} else if ('threadPin' in mod) {
		patch = {
			syncAction: {
				threadPinAction: {
					pinned: !!mod.threadPin.pinned
				}
			},
			index: ['thread_pin', jid, mod.threadPin.messageId || ''],
			type: 'regular_low',
			apiVersion: 1,
			operation: OP.SET
		}
	} else if ('chatLock' in mod) {
		patch = {
			syncAction: {
				lockChatAction: {
					locked: mod.chatLock.locked !== false
				}
			},
			index: ['lock_chat', jid],
			type: 'regular_high',
			apiVersion: 1,
			operation: OP.SET
		}
	} else if ('wallpaper' in mod) {
		const wallpaperData = mod.wallpaper || {}
		patch = {
			syncAction: {
				chatCustomImageWallpaper: wallpaperData.remove
					? {}
					: {
							directPath: wallpaperData.directPath,
							mediaKey: wallpaperData.mediaKey,
							fileEncSha256: wallpaperData.fileEncSha256,
							fileSha256: wallpaperData.fileSha256,
							dimLevel: wallpaperData.dimLevel ?? 0
						}
			},
			index: ['chat_custom_image_wallpaper', jid],
			type: 'regular',
			apiVersion: 1,
			operation: wallpaperData.remove ? OP.REMOVE : OP.SET
		}
	} else if ('mediaVisibility' in mod) {
		const visibilityEnum = index_js_1.proto.MediaVisibility
		const visMap = { default: visibilityEnum.DEFAULT, off: visibilityEnum.OFF, on: visibilityEnum.ON }
		const visibility =
			typeof mod.mediaVisibility === 'string'
				? (visMap[mod.mediaVisibility.toLowerCase()] ?? visibilityEnum.DEFAULT)
				: (mod.mediaVisibility ?? visibilityEnum.DEFAULT)
		patch = {
			syncAction: {
				mediaVisibilityAction: { visibility }
			},
			index: ['media_visibility', jid],
			type: 'regular',
			apiVersion: 1,
			operation: OP.SET
		}
	} else if ('privateProcessingSetting' in mod) {
		const statusEnum = index_js_1.proto.SyncActionValue.PrivateProcessingSettingAction.PrivateProcessingStatus
		const statusMap = { enabled: statusEnum.ENABLED, disabled: statusEnum.DISABLED }
		const status =
			typeof mod.privateProcessingSetting === 'string'
				? (statusMap[mod.privateProcessingSetting.toLowerCase()] ?? statusEnum.ENABLED)
				: (mod.privateProcessingSetting.status ??
					(mod.privateProcessingSetting.enabled ? statusEnum.ENABLED : statusEnum.DISABLED))
		patch = {
			syncAction: {
				privateProcessingSettingAction: { privateProcessingStatus: status }
			},
			index: ['setting_private_processing'],
			type: 'regular',
			apiVersion: 1,
			operation: OP.SET
		}
	} else if ('externalWebBeta' in mod) {
		patch = {
			syncAction: {
				externalWebBetaAction: { isOptIn: !!mod.externalWebBeta }
			},
			index: ['setting_external_web_beta'],
			type: 'regular',
			apiVersion: 1,
			operation: OP.SET
		}
	} else if ('maibaAIFeatures' in mod) {
		const statusEnum = index_js_1.proto.SyncActionValue.MaibaAIFeaturesControlAction.MaibaAIFeatureStatus
		const replyModeEnum = index_js_1.proto.SyncActionValue.MaibaAIFeaturesControlAction.MaibaAIReplyMode
		const statusMap = {
			enabled: statusEnum.ENABLED,
			enabled_has_learning: statusEnum.ENABLED_HAS_LEARNING,
			disabled: statusEnum.DISABLED
		}
		const replyModeMap = {
			muted: replyModeEnum.MUTED,
			ai_agent: replyModeEnum.AI_AGENT,
			suggestions: replyModeEnum.SUGGESTIONS
		}
		const aiFeatures = mod.maibaAIFeatures
		const status =
			typeof aiFeatures.status === 'string' ? (statusMap[aiFeatures.status] ?? statusEnum.ENABLED) : aiFeatures.status
		const replyMode =
			typeof aiFeatures.replyMode === 'string'
				? (replyModeMap[aiFeatures.replyMode] ?? replyModeEnum.SUGGESTIONS)
				: aiFeatures.replyMode
		patch = {
			syncAction: {
				maibaAiFeaturesControlAction: { aiFeatureStatus: status, aiReplyMode: replyMode }
			},
			index: ['setting_maiba_ai'],
			type: 'regular',
			apiVersion: 1,
			operation: OP.SET
		}
	} else {
		throw new boom_1.Boom('not supported')
	}
	patch.syncAction.timestamp = Date.now()
	return patch
}
exports.chatModificationToAppPatch = chatModificationToAppPatch
const processSyncAction = (syncAction, ev, me, initialSyncOpts, logger) => {
	const isInitialSync = !!initialSyncOpts
	const accountSettings = initialSyncOpts?.accountSettings
	logger?.trace({ syncAction, initialSync: !!initialSyncOpts }, 'processing sync action')
	const {
		syncAction: { value: action },
		index: [type, id, msgId, fromMe]
	} = syncAction
	if (action?.muteAction) {
		ev.emit('chats.update', [
			{
				id,
				muteEndTime: action.muteAction?.muted ? (0, generics_1.toNumber)(action.muteAction.muteEndTimestamp) : null,
				conditional: getChatUpdateConditional(id, undefined)
			}
		])
	} else if (action?.archiveChatAction || type === 'archive' || type === 'unarchive') {
		// okay so we've to do some annoying computation here
		// when we're initially syncing the app state
		// there are a few cases we need to handle
		// 1. if the account unarchiveChats setting is true
		//   a. if the chat is archived, and no further messages have been received -- simple, keep archived
		//   b. if the chat was archived, and the user received messages from the other person afterwards
		//		then the chat should be marked unarchved --
		//		we compare the timestamp of latest message from the other person to determine this
		// 2. if the account unarchiveChats setting is false -- then it doesn't matter,
		//	it'll always take an app state action to mark in unarchived -- which we'll get anyway
		const archiveAction = action?.archiveChatAction
		const isArchived = archiveAction ? archiveAction.archived : type === 'archive'
		// // basically we don't need to fire an "archive" update if the chat is being marked unarchvied
		// // this only applies for the initial sync
		// if(isInitialSync && !isArchived) {
		// 	isArchived = false
		// }
		const msgRange = !accountSettings?.unarchiveChats ? undefined : archiveAction?.messageRange
		// logger?.debug({ chat: id, syncAction }, 'message range archive')
		ev.emit('chats.update', [
			{
				id,
				archived: isArchived,
				conditional: getChatUpdateConditional(id, msgRange)
			}
		])
	} else if (action?.markChatAsReadAction) {
		const markReadAction = action.markChatAsReadAction
		// basically we don't need to fire an "read" update if the chat is being marked as read
		// because the chat is read by default
		// this only applies for the initial sync
		const isNullUpdate = isInitialSync && markReadAction.read
		ev.emit('chats.update', [
			{
				id,
				unreadCount: isNullUpdate ? null : !!markReadAction?.read ? 0 : -1,
				conditional: getChatUpdateConditional(id, markReadAction?.messageRange)
			}
		])
	} else if (action?.deleteMessageForMeAction || type === 'deleteMessageForMe') {
		ev.emit('messages.delete', {
			keys: [
				{
					remoteJid: id,
					id: msgId,
					fromMe: fromMe === '1'
				}
			]
		})
	} else if (action?.contactAction) {
		const results = (0, sync_action_utils_1.processContactAction)(action.contactAction, id, logger)
		;(0, sync_action_utils_1.emitSyncActionResults)(ev, results)
	} else if (action?.pushNameSetting) {
		const name = action?.pushNameSetting?.name
		if (name && me?.name !== name) {
			ev.emit('creds.update', { me: { ...me, name } })
		}
	} else if (action?.pinAction) {
		ev.emit('chats.update', [
			{
				id,
				pinned: action.pinAction?.pinned ? (0, generics_1.toNumber)(action.timestamp) : null,
				conditional: getChatUpdateConditional(id, undefined)
			}
		])
	} else if (action?.unarchiveChatsSetting) {
		const unarchiveChats = !!action.unarchiveChatsSetting.unarchiveChats
		ev.emit('creds.update', { accountSettings: { unarchiveChats } })
		logger?.info(`archive setting updated => '${action.unarchiveChatsSetting.unarchiveChats}'`)
		if (accountSettings) {
			accountSettings.unarchiveChats = unarchiveChats
		}
	} else if (action?.starAction || type === 'star') {
		let starred = action?.starAction?.starred
		if (typeof starred !== 'boolean') {
			starred = syncAction.index[syncAction.index.length - 1] === '1'
		}
		ev.emit('messages.update', [
			{
				key: { remoteJid: id, id: msgId, fromMe: fromMe === '1' },
				update: { starred }
			}
		])
	} else if (action?.deleteChatAction || type === 'deleteChat') {
		if (!isInitialSync) {
			ev.emit('chats.delete', [id])
		}
	} else if (action?.labelEditAction) {
		const { name, color, deleted, predefinedId } = action.labelEditAction
		ev.emit('labels.edit', {
			id: id,
			name: name,
			color: color,
			deleted: deleted,
			predefinedId: predefinedId ? String(predefinedId) : undefined
		})
	} else if (action?.labelAssociationAction) {
		ev.emit('labels.association', {
			type: action.labelAssociationAction.labeled ? 'add' : 'remove',
			association:
				type === LabelAssociation_1.LabelAssociationType.Chat
					? {
							type: LabelAssociation_1.LabelAssociationType.Chat,
							chatId: syncAction.index[2],
							labelId: syncAction.index[1]
						}
					: {
							type: LabelAssociation_1.LabelAssociationType.Message,
							chatId: syncAction.index[2],
							messageId: syncAction.index[3],
							labelId: syncAction.index[1]
						}
		})
	} else if (action?.localeSetting?.locale) {
		ev.emit('settings.update', { setting: 'locale', value: action.localeSetting.locale })
	} else if (action?.timeFormatAction) {
		ev.emit('settings.update', { setting: 'timeFormat', value: action.timeFormatAction })
	} else if (action?.pnForLidChatAction) {
		if (action.pnForLidChatAction.pnJid) {
			ev.emit('lid-mapping.update', { lid: id, pn: action.pnForLidChatAction.pnJid })
		}
	} else if (action?.privacySettingRelayAllCalls) {
		ev.emit('settings.update', {
			setting: 'privacySettingRelayAllCalls',
			value: action.privacySettingRelayAllCalls
		})
	} else if (action?.statusPrivacy) {
		ev.emit('settings.update', { setting: 'statusPrivacy', value: action.statusPrivacy })
	} else if (action?.lockChatAction) {
		ev.emit('chats.lock', { id: id, locked: !!action.lockChatAction.locked })
	} else if (action?.privacySettingDisableLinkPreviewsAction) {
		ev.emit('settings.update', {
			setting: 'disableLinkPreviews',
			value: action.privacySettingDisableLinkPreviewsAction
		})
	} else if (action?.notificationActivitySettingAction?.notificationActivitySetting) {
		ev.emit('settings.update', {
			setting: 'notificationActivitySetting',
			value: action.notificationActivitySettingAction.notificationActivitySetting
		})
	} else if (action?.lidContactAction) {
		ev.emit('contacts.upsert', [
			{
				id: id,
				name:
					action.lidContactAction.fullName ||
					action.lidContactAction.firstName ||
					action.lidContactAction.username ||
					undefined,
				username: action.lidContactAction.username || undefined,
				lid: id,
				phoneNumber: undefined
			}
		])
	} else if (action?.privacySettingChannelsPersonalisedRecommendationAction) {
		ev.emit('settings.update', {
			setting: 'channelsPersonalisedRecommendation',
			value: action.privacySettingChannelsPersonalisedRecommendationAction
		})
	} else if (action?.aiThreadRenameAction) {
		ev.emit('chats.update', [
			{
				id,
				name: action.aiThreadRenameAction.newTitle,
				conditional: getChatUpdateConditional(id, undefined)
			}
		])
	} else if (action?.threadPinAction) {
		ev.emit('chats.update', [
			{
				id,
				pinned: action.threadPinAction.pinned ? (0, generics_1.toNumber)(action.timestamp) : null,
				conditional: getChatUpdateConditional(id, undefined)
			}
		])
	} else if (action?.privateProcessingSettingAction) {
		ev.emit('settings.update', {
			setting: 'privateProcessing',
			value: action.privateProcessingSettingAction
		})
	} else if (action?.settingsSyncAction) {
		ev.emit('settings.update', {
			setting: 'clientSettings',
			value: action.settingsSyncAction
		})
	} else if (action?.musicUserIdAction) {
		ev.emit('settings.update', {
			setting: 'musicUserId',
			value: action.musicUserIdAction
		})
	} else if (action?.avatarUpdatedAction) {
		ev.emit('settings.update', {
			setting: 'avatarUpdated',
			value: action.avatarUpdatedAction
		})
	} else if (action?.recentEmojiWeightsAction) {
		ev.emit('settings.update', {
			setting: 'recentEmojiWeights',
			value: action.recentEmojiWeightsAction?.weights || []
		})
	} else if (action?.stickerAction) {
		ev.emit('settings.update', { setting: 'stickerSync', value: action.stickerAction })
	} else if (action?.removeRecentStickerAction) {
		ev.emit('settings.update', { setting: 'removedRecentSticker', value: action.removeRecentStickerAction })
	} else if (action?.userStatusMuteAction) {
		ev.emit('contacts.update', [{ id, statusMuted: !!action.userStatusMuteAction.muted }])
	} else if (action?.chatAssignment) {
		ev.emit('chats.update', [
			{
				id,
				chatAssignment: action.chatAssignment,
				conditional: getChatUpdateConditional(id, undefined)
			}
		])
	} else if (action?.chatAssignmentOpenedStatus) {
		ev.emit('chats.update', [
			{
				id,
				chatAssignmentOpened: !!action.chatAssignmentOpenedStatus.opened,
				conditional: getChatUpdateConditional(id, undefined)
			}
		])
	} else if (action?.callLogAction) {
		ev.emit('settings.update', { setting: 'callLog', value: action.callLogAction })
	} else if (action?.deleteIndividualCallLog) {
		ev.emit('settings.update', { setting: 'callLogDeleted', value: action.deleteIndividualCallLog })
	} else if (action?.labelReorderingAction) {
		ev.emit('labels.reorder', { labelIds: action.labelReorderingAction.sortedLabelIds || [] })
	} else if (action?.paymentInfoAction) {
		ev.emit('settings.update', { setting: 'paymentInfo', value: action.paymentInfoAction })
	} else if (action?.noteEditAction) {
		ev.emit('chats.update', [
			{ id, draftNote: action.noteEditAction, conditional: getChatUpdateConditional(id, undefined) }
		])
	} else if (action?.favoritesAction) {
		ev.emit('contacts.update', [{ id, favorite: !!action.favoritesAction.isFavorite }])
	} else if (action?.usernameChatStartMode) {
		ev.emit('settings.update', { setting: 'usernameChatStartMode', value: action.usernameChatStartMode })
	} else if (action?.maibaAiFeaturesControlAction) {
		ev.emit('settings.update', { setting: 'aiFeatures', value: action.maibaAiFeaturesControlAction })
	} else if (action?.statusPostOptInNotificationPreferencesAction) {
		ev.emit('settings.update', {
			setting: 'statusPostOptInNotifications',
			value: action.statusPostOptInNotificationPreferencesAction
		})
	} else if (action?.subscriptionsSyncV2Action) {
		ev.emit('settings.update', { setting: 'subscriptions', value: action.subscriptionsSyncV2Action })
	} else if (action?.newsletterSavedInterestsAction) {
		ev.emit('settings.update', { setting: 'newsletterSavedInterests', value: action.newsletterSavedInterestsAction })
	} else if (action?.interactiveMessageAction) {
		ev.emit('settings.update', { setting: 'interactiveMessageAction', value: action.interactiveMessageAction })
	} else if (action?.outContactAction) {
		const results = (0, sync_action_utils_1.processContactAction)(
			{
				fullName: action.outContactAction.fullName,
				firstName: action.outContactAction.firstName
			},
			id,
			logger
		)
		;(0, sync_action_utils_1.emitSyncActionResults)(ev, results)
	} else if (action?.businessBroadcastListAction) {
		ev.emit('settings.update', { setting: 'broadcastList', value: action.businessBroadcastListAction })
	} else if (action?.customerDataAction) {
		ev.emit('chats.update', [
			{ id, customerData: action.customerDataAction, conditional: getChatUpdateConditional(id, undefined) }
		])
	} else if (action?.autoOrganizeBusinessChatSetting) {
		ev.emit('settings.update', { setting: 'autoOrganizeBusinessChat', value: action.autoOrganizeBusinessChatSetting })
	} else if (action?.chatLockSettings) {
		ev.emit('chats.update', [
			{ id, chatLockSettings: action.chatLockSettings, conditional: getChatUpdateConditional(id, undefined) }
		])
	} else if (action?.agentAction) {
		ev.emit('settings.update', { setting: 'agentAction', value: action.agentAction })
	} else if (action?.nuxAction) {
		ev.emit('settings.update', { setting: 'nux', value: action.nuxAction })
	} else if (action?.quickReplyAction) {
		ev.emit('settings.update', { setting: 'quickReply', value: action.quickReplyAction })
	} else if (action?.keyExpiration) {
		ev.emit('settings.update', { setting: 'keyExpiration', value: action.keyExpiration })
	} else if (action?.primaryFeature) {
		ev.emit('settings.update', { setting: 'primaryFeature', value: action.primaryFeature })
	} else if (action?.androidUnsupportedActions) {
		ev.emit('settings.update', { setting: 'androidUnsupported', value: action.androidUnsupportedActions })
	} else if (action?.subscriptionAction) {
		ev.emit('settings.update', { setting: 'subscription', value: action.subscriptionAction })
	} else if (action?.primaryVersionAction) {
		ev.emit('settings.update', { setting: 'primaryVersion', value: action.primaryVersionAction })
	} else if (action?.marketingMessageAction) {
		ev.emit('settings.update', { setting: 'marketingMessage', value: action.marketingMessageAction })
	} else if (action?.marketingMessageBroadcastAction) {
		ev.emit('settings.update', { setting: 'marketingMessageBroadcast', value: action.marketingMessageBroadcastAction })
	} else if (action?.externalWebBetaAction) {
		ev.emit('settings.update', { setting: 'externalWebBeta', value: action.externalWebBetaAction })
	} else if (action?.botWelcomeRequestAction) {
		ev.emit('settings.update', { setting: 'botWelcomeRequest', value: action.botWelcomeRequestAction })
	} else if (action?.customPaymentMethodsAction) {
		ev.emit('settings.update', { setting: 'customPaymentMethods', value: action.customPaymentMethodsAction })
	} else if (action?.wamoUserIdentifierAction) {
		ev.emit('settings.update', { setting: 'wamoUserIdentifier', value: action.wamoUserIdentifierAction })
	} else if (action?.merchantPaymentPartnerAction) {
		ev.emit('settings.update', { setting: 'merchantPaymentPartner', value: action.merchantPaymentPartnerAction })
	} else if (action?.waffleAccountLinkStateAction) {
		ev.emit('settings.update', { setting: 'waffleAccountLinkState', value: action.waffleAccountLinkStateAction })
	} else if (action?.ctwaPerCustomerDataSharingAction) {
		ev.emit('settings.update', { setting: 'ctwaDataSharing', value: action.ctwaPerCustomerDataSharingAction })
	} else if (action?.paymentTosAction) {
		ev.emit('settings.update', { setting: 'paymentTos', value: action.paymentTosAction })
	} else if (action?.detectedOutcomesStatusAction) {
		ev.emit('settings.update', { setting: 'detectedOutcomesStatus', value: action.detectedOutcomesStatusAction })
	} else if (action?.nctSaltSyncAction) {
		ev.emit('settings.update', { setting: 'nctSaltSync', value: action.nctSaltSyncAction })
	} else if (action?.businessBroadcastCampaignAction) {
		ev.emit('settings.update', { setting: 'businessBroadcastCampaign', value: action.businessBroadcastCampaignAction })
	} else if (action?.businessBroadcastInsightsAction) {
		ev.emit('settings.update', { setting: 'businessBroadcastInsights', value: action.businessBroadcastInsightsAction })
	} else if (action?.bizAiSettingsNudgeAction) {
		ev.emit('settings.update', { setting: 'bizAiSettingsNudge', value: action.bizAiSettingsNudgeAction })
	} else if (action?.clearChatAction) {
		ev.emit('chats.update', [
			{
				id,
				lastMessageRecvTimestamp: 0,
				conditional: getChatUpdateConditional(id, action.clearChatAction?.messageRange)
			}
		])
	} else if (action?.deviceCapabilities) {
		ev.emit('settings.update', { setting: 'deviceCapabilities', value: action.deviceCapabilities })
	} else if (action?.ugcBot) {
		ev.emit('settings.update', { setting: 'ugcBot', value: action.ugcBot })
	} else if (action?.coexV2VersionAction) {
		ev.emit('settings.update', { setting: 'coexV2Version', value: action.coexV2VersionAction })
	} else if (action?.wasaRootSecretAction) {
		ev.emit('settings.update', { setting: 'wasaRootSecret', value: action.wasaRootSecretAction })
	} else if (action?.bubbleLockMessageAction) {
		ev.emit('messages.update', [
			{
				key: { remoteJid: id, id: msgId, fromMe: fromMe === '1' },
				update: { bubbleLocked: action.bubbleLockMessageAction?.locked }
			}
		])
	} else if (action?.labelSublistAction) {
		ev.emit('chats.update', [
			{ id, labelSublistId: action.labelSublistAction?.subListId, conditional: getChatUpdateConditional(id, undefined) }
		])
	} else {
		logger?.debug({ syncAction, id }, 'unprocessable update')
	}
	function getChatUpdateConditional(id, msgRange) {
		return isInitialSync
			? data => {
					const chat = data.historySets.chats[id] || data.chatUpserts[id]
					if (chat) {
						return msgRange ? isValidPatchBasedOnMessageRange(chat, msgRange) : true
					}
				}
			: undefined
	}
	function isValidPatchBasedOnMessageRange(chat, msgRange) {
		const lastMsgTimestamp = Number(msgRange?.lastMessageTimestamp || msgRange?.lastSystemMessageTimestamp || 0)
		const chatLastMsgTimestamp = Number(chat?.lastMessageRecvTimestamp || 0)
		return lastMsgTimestamp >= chatLastMsgTimestamp
	}
}
exports.processSyncAction = processSyncAction
