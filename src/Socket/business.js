'use strict'
Object.defineProperty(exports, '__esModule', { value: true })
exports.makeBusinessSocket = void 0
const Utils_1 = require('../Utils')
const business_1 = require('../Utils/business')
const WABinary_1 = require('../WABinary')
const generic_utils_1 = require('../WABinary/generic-utils')
const messages_recv_1 = require('./messages-recv')
const mex_1 = require('./mex')

// GraphQL (w:mex) query IDs for catalog/collection management mutations.
// Sourced from wa-protocol-all-2026-08-28T12-15-31-087Z/biz.json
// (WAWebBizCatalogManagement*Mutation_facebookRelayOperation.source) — verified 2026-08-28
const CATALOG_MEX_QUERY_IDS = {
	CREATE_CATALOG: '29232780583035464', // WAWebBizCatalogManagementCreateCatalogMutation — verified 2026-08-28
	CREATE_COLLECTION: '29361942130088470', // WAWebBizCatalogManagementCreateCollectionMutation — verified 2026-08-28
	UPDATE_COLLECTION: '24486970300891371', // WAWebBizCatalogManagementUpdateCollectionMutation — verified 2026-08-28
	DELETE_COLLECTIONS: '29970196299234260', // WAWebBizCatalogManagementDeleteCollectionsMutation — verified 2026-08-28
	APPEAL_PRODUCT: '29276343172013990', // WAWebBizCatalogManagementAppealProductMutation — verified 2026-08-28
	APPEAL_COLLECTION: '9971242039605207' // WAWebBizCatalogManagementAppealCollectionMutation — verified 2026-08-28
}
const makeBusinessSocket = config => {
	const sock = (0, messages_recv_1.makeMessagesRecvSocket)(config)
	const { authState, query, waUploadToServer, generateMessageTag } = sock
	const mexQuery = (variables, queryId, dataPath) =>
		(0, mex_1.executeWMexQuery)(variables, queryId, dataPath, query, generateMessageTag)
	const updateBussinesProfile = async args => {
		const node = []
		const simpleFields = ['address', 'email', 'description']
		node.push(
			...simpleFields
				.filter(key => args[key] !== undefined && args[key] !== null)
				.map(key => ({
					tag: key,
					attrs: {},
					content: args[key]
				}))
		)
		if (args.websites !== undefined) {
			node.push(
				...args.websites.map(website => ({
					tag: 'website',
					attrs: {},
					content: website
				}))
			)
		}
		if (args.hours !== undefined) {
			node.push({
				tag: 'business_hours',
				attrs: { timezone: args.hours.timezone },
				content: args.hours.days.map(dayConfig => {
					const base = {
						tag: 'business_hours_config',
						attrs: {
							day_of_week: dayConfig.day,
							mode: dayConfig.mode
						}
					}
					if (dayConfig.mode === 'specific_hours') {
						return {
							...base,
							attrs: {
								...base.attrs,
								open_time: dayConfig.openTimeInMinutes,
								close_time: dayConfig.closeTimeInMinutes
							}
						}
					}
					return base
				})
			})
		}
		const result = await query({
			tag: 'iq',
			attrs: {
				to: WABinary_1.S_WHATSAPP_NET,
				type: 'set',
				xmlns: 'w:biz'
			},
			content: [
				{
					tag: 'business_profile',
					attrs: {
						v: '3',
						mutation_type: 'delta'
					},
					content: node
				}
			]
		})
		return result
	}
	const updateCoverPhoto = async photo => {
		const { fileSha256, filePath } = await (0, Utils_1.getRawMediaUploadData)(photo, 'biz-cover-photo')
		const fileSha256B64 = fileSha256.toString('base64')
		const { meta_hmac, fbid, ts } = await waUploadToServer(filePath, {
			fileEncSha256B64: fileSha256B64,
			mediaType: 'biz-cover-photo'
		})
		await query({
			tag: 'iq',
			attrs: {
				to: WABinary_1.S_WHATSAPP_NET,
				type: 'set',
				xmlns: 'w:biz'
			},
			content: [
				{
					tag: 'business_profile',
					attrs: {
						v: '3',
						mutation_type: 'delta'
					},
					content: [
						{
							tag: 'cover_photo',
							attrs: { id: String(fbid), op: 'update', token: meta_hmac, ts: String(ts) }
						}
					]
				}
			]
		})
		return fbid
	}
	const removeCoverPhoto = async id => {
		return await query({
			tag: 'iq',
			attrs: {
				to: WABinary_1.S_WHATSAPP_NET,
				type: 'set',
				xmlns: 'w:biz'
			},
			content: [
				{
					tag: 'business_profile',
					attrs: {
						v: '3',
						mutation_type: 'delta'
					},
					content: [
						{
							tag: 'cover_photo',
							attrs: { op: 'delete', id }
						}
					]
				}
			]
		})
	}
	const getCatalog = async ({ jid, limit, cursor }) => {
		jid = jid || authState.creds.me?.id
		jid = (0, WABinary_1.jidNormalizedUser)(jid)
		const queryParamNodes = [
			{
				tag: 'limit',
				attrs: {},
				content: Buffer.from((limit || 10).toString())
			},
			{
				tag: 'width',
				attrs: {},
				content: Buffer.from('100')
			},
			{
				tag: 'height',
				attrs: {},
				content: Buffer.from('100')
			}
		]
		if (cursor) {
			queryParamNodes.push({
				tag: 'after',
				attrs: {},
				content: cursor
			})
		}
		const result = await query({
			tag: 'iq',
			attrs: {
				to: WABinary_1.S_WHATSAPP_NET,
				type: 'get',
				xmlns: 'w:biz:catalog'
			},
			content: [
				{
					tag: 'product_catalog',
					attrs: {
						jid,
						allow_shop_source: 'true'
					},
					content: queryParamNodes
				}
			]
		})
		return (0, business_1.parseCatalogNode)(result)
	}
	const getCollections = async (jid, limit = 51) => {
		jid = jid || authState.creds.me?.id
		jid = (0, WABinary_1.jidNormalizedUser)(jid)
		const result = await query({
			tag: 'iq',
			attrs: {
				to: WABinary_1.S_WHATSAPP_NET,
				type: 'get',
				xmlns: 'w:biz:catalog',
				smax_id: '35'
			},
			content: [
				{
					tag: 'collections',
					attrs: {
						biz_jid: jid
					},
					content: [
						{
							tag: 'collection_limit',
							attrs: {},
							content: Buffer.from(limit.toString())
						},
						{
							tag: 'item_limit',
							attrs: {},
							content: Buffer.from(limit.toString())
						},
						{
							tag: 'width',
							attrs: {},
							content: Buffer.from('100')
						},
						{
							tag: 'height',
							attrs: {},
							content: Buffer.from('100')
						}
					]
				}
			]
		})
		return (0, business_1.parseCollectionsNode)(result)
	}
	const getOrderDetails = async (orderId, tokenBase64) => {
		const result = await query({
			tag: 'iq',
			attrs: {
				to: WABinary_1.S_WHATSAPP_NET,
				type: 'get',
				xmlns: 'fb:thrift_iq',
				smax_id: '5'
			},
			content: [
				{
					tag: 'order',
					attrs: {
						op: 'get',
						id: orderId
					},
					content: [
						{
							tag: 'image_dimensions',
							attrs: {},
							content: [
								{
									tag: 'width',
									attrs: {},
									content: Buffer.from('100')
								},
								{
									tag: 'height',
									attrs: {},
									content: Buffer.from('100')
								}
							]
						},
						{
							tag: 'token',
							attrs: {},
							content: Buffer.from(tokenBase64)
						}
					]
				}
			]
		})
		return (0, business_1.parseOrderDetailsNode)(result)
	}
	/**
	 * Get linked Facebook/Instagram accounts (WhatsApp-as-a-page linking).
	 * Ported from WhatsApp Web's WASmaxBizLinkingGetLinkedAccountsRPC.
	 * @returns {Promise<{ pageInfo: object, linkState?: string, node: object } | undefined>}
	 */
	const getLinkedAccounts = async () => {
		const result = await query({
			tag: 'iq',
			attrs: { to: WABinary_1.S_WHATSAPP_NET, type: 'get', xmlns: 'fb:thrift_iq', smax_id: '42' },
			content: [{ tag: 'linked_accounts', attrs: {} }]
		})
		const fbPage = (0, WABinary_1.getBinaryNodeChild)(result, 'fb_page')
		if (!fbPage) return undefined
		const button = (0, WABinary_1.getBinaryNodeChild)(fbPage, 'whatsapp_as_page_button')
		return { pageInfo: fbPage.attrs, linkState: button?.attrs?.state, node: fbPage }
	}
	/**
	 * Get business eligibility for the given features (meta_verified / marketing_messages / genai).
	 * Ported from WhatsApp Web's WASmaxBizMarketingMessageGetBusinessEligibilityRPC.
	 * @param {{ metaVerified?: any, marketingMessages?: any, genai?: any }} [features]
	 */
	const getBusinessEligibility = async (features = {}) => {
		const attrs = {}
		if (features.metaVerified !== undefined) attrs.meta_verified = String(features.metaVerified)
		if (features.marketingMessages !== undefined) attrs.marketing_messages = String(features.marketingMessages)
		if (features.genai !== undefined) attrs.genai = String(features.genai)
		const result = await query({
			tag: 'iq',
			attrs: { to: WABinary_1.S_WHATSAPP_NET, type: 'get', xmlns: 'w:biz', smax_id: '139' },
			content: [{ tag: 'features', attrs }]
		})
		const mv = (0, WABinary_1.getBinaryNodeChild)(result, 'meta_verified')
		return mv ? { status: mv.attrs?.status, ...mv.attrs } : undefined
	}
	const productUpdate = async (productId, update) => {
		update = await (0, business_1.uploadingNecessaryImagesOfProduct)(update, waUploadToServer)
		const editNode = (0, business_1.toProductNode)(productId, update)
		const result = await query({
			tag: 'iq',
			attrs: {
				to: WABinary_1.S_WHATSAPP_NET,
				type: 'set',
				xmlns: 'w:biz:catalog'
			},
			content: [
				{
					tag: 'product_catalog_edit',
					attrs: { v: '1' },
					content: [
						editNode,
						{
							tag: 'width',
							attrs: {},
							content: '100'
						},
						{
							tag: 'height',
							attrs: {},
							content: '100'
						}
					]
				}
			]
		})
		const productCatalogEditNode = (0, generic_utils_1.getBinaryNodeChild)(result, 'product_catalog_edit')
		const productNode = (0, generic_utils_1.getBinaryNodeChild)(productCatalogEditNode, 'product')
		return (0, business_1.parseProductNode)(productNode)
	}
	const productCreate = async create => {
		// ensure isHidden is defined
		create.isHidden = !!create.isHidden
		create = await (0, business_1.uploadingNecessaryImagesOfProduct)(create, waUploadToServer)
		const createNode = (0, business_1.toProductNode)(undefined, create)
		const result = await query({
			tag: 'iq',
			attrs: {
				to: WABinary_1.S_WHATSAPP_NET,
				type: 'set',
				xmlns: 'w:biz:catalog'
			},
			content: [
				{
					tag: 'product_catalog_add',
					attrs: { v: '1' },
					content: [
						createNode,
						{
							tag: 'width',
							attrs: {},
							content: '100'
						},
						{
							tag: 'height',
							attrs: {},
							content: '100'
						}
					]
				}
			]
		})
		const productCatalogAddNode = (0, generic_utils_1.getBinaryNodeChild)(result, 'product_catalog_add')
		const productNode = (0, generic_utils_1.getBinaryNodeChild)(productCatalogAddNode, 'product')
		return (0, business_1.parseProductNode)(productNode)
	}
	const productDelete = async productIds => {
		const result = await query({
			tag: 'iq',
			attrs: {
				to: WABinary_1.S_WHATSAPP_NET,
				type: 'set',
				xmlns: 'w:biz:catalog'
			},
			content: [
				{
					tag: 'product_catalog_delete',
					attrs: { v: '1' },
					content: productIds.map(id => ({
						tag: 'product',
						attrs: {},
						content: [
							{
								tag: 'id',
								attrs: {},
								content: Buffer.from(id)
							}
						]
					}))
				}
			]
		})
		const productCatalogDelNode = (0, generic_utils_1.getBinaryNodeChild)(result, 'product_catalog_delete')
		return {
			deleted: +(productCatalogDelNode?.attrs.deleted_count || 0)
		}
	}
	/**
	 * Create a new product catalog.
	 * Ported from WhatsApp Web's WAWebBizCatalogManagementCreateCatalogMutation (xfb_whatsapp_catalog_create).
	 * @param {object} input - Mutation input (relay `request` variable), e.g. `{ name, vertical, ... }`
	 * @returns {Promise<{ success?: boolean }>}
	 */
	const catalogCreate = async input => {
		return mexQuery({ input }, CATALOG_MEX_QUERY_IDS.CREATE_CATALOG, 'xfb_whatsapp_catalog_create')
	}
	/**
	 * Create a new product collection within a catalog.
	 * Ported from WhatsApp Web's WAWebBizCatalogManagementCreateCollectionMutation (xfb_whatsapp_catalog_create_collection).
	 * @param {object} input - Mutation input (relay `request` variable), e.g. `{ catalog_id, name, product_ids, ... }`
	 * @returns {Promise<{ collection?: { id: string, status_info?: { status: string } } }>}
	 */
	const collectionCreate = async input => {
		return mexQuery({ input }, CATALOG_MEX_QUERY_IDS.CREATE_COLLECTION, 'xfb_whatsapp_catalog_create_collection')
	}
	/**
	 * Update an existing collection (name, product list, etc).
	 * Ported from WhatsApp Web's WAWebBizCatalogManagementUpdateCollectionMutation (xfb_whatsapp_catalog_update_collection).
	 * @param {object} input - Mutation input (relay `request` variable), e.g. `{ collection_id, name, product_ids, ... }`
	 * @returns {Promise<{ collection?: { id: string, status_info?: { status: string } } }>}
	 */
	const collectionUpdate = async input => {
		return mexQuery({ input }, CATALOG_MEX_QUERY_IDS.UPDATE_COLLECTION, 'xfb_whatsapp_catalog_update_collection')
	}
	/**
	 * Delete one or more collections.
	 * Ported from WhatsApp Web's WAWebBizCatalogManagementDeleteCollectionsMutation (xfb_whatsapp_catalog_delete_collections).
	 * @param {object} input - Mutation input (relay `request` variable), e.g. `{ collection_ids }`
	 * @returns {Promise<{ success?: boolean }>}
	 */
	const collectionsDelete = async input => {
		return mexQuery({ input }, CATALOG_MEX_QUERY_IDS.DELETE_COLLECTIONS, 'xfb_whatsapp_catalog_delete_collections')
	}
	/**
	 * Appeal a rejected/blocked product listing.
	 * Ported from WhatsApp Web's WAWebBizCatalogManagementAppealProductMutation (xfb_whatsapp_catalog_appeal_product).
	 * @param {object} input - Mutation input (relay `request` variable), e.g. `{ product_id, catalog_id, ... }`
	 * @returns {Promise<{ success?: boolean }>}
	 */
	const productAppeal = async input => {
		return mexQuery({ input }, CATALOG_MEX_QUERY_IDS.APPEAL_PRODUCT, 'xfb_whatsapp_catalog_appeal_product')
	}
	/**
	 * Appeal a rejected/blocked collection.
	 * Ported from WhatsApp Web's WAWebBizCatalogManagementAppealCollectionMutation (xfb_whatsapp_catalog_appeal_collection).
	 * @param {object} input - Mutation input (relay `request` variable), e.g. `{ collection_id, catalog_id, ... }`
	 * @returns {Promise<{ success?: boolean }>}
	 */
	const collectionAppeal = async input => {
		return mexQuery({ input }, CATALOG_MEX_QUERY_IDS.APPEAL_COLLECTION, 'xfb_whatsapp_catalog_appeal_collection')
	}
	/**
	 * Get a CTWA (Click-to-WhatsApp-Ads) ad-account access token and session cookies.
	 * Ported from WhatsApp Web's WASmaxBizCtwaAdAccountGetAccessTokenAndSessionCookiesRPC.
	 * Same transport family as getLinkedAccounts (fb:thrift_iq + smax_id), confirmed from
	 * WASmaxOutBizCtwaAdAccountGetAccessTokenAndSessionCookiesRequest in smax.json (smax_id 104,
	 * payload `<parameters><code>{nonce}</code></parameters>`) — verified 2026-08-28.
	 * The `code` is the one-time nonce delivered via the server-pushed CTWA nonce notification
	 * (see `business.ctwa-nonce` event, handled in messages-recv.js).
	 * @param {string} code - The nonce code to exchange for an access token + session cookies.
	 */
	const ctwaAdAccountGetAccessTokenAndSessionCookies = async code => {
		const result = await query({
			tag: 'iq',
			attrs: { to: WABinary_1.S_WHATSAPP_NET, type: 'get', xmlns: 'fb:thrift_iq', smax_id: '104' },
			content: [
				{
					tag: 'parameters',
					attrs: {},
					content: [{ tag: 'code', attrs: {}, content: Buffer.from(code) }]
				}
			]
		})
		return result
	}
	return {
		...sock,
		logger: config.logger,
		getOrderDetails,
		getLinkedAccounts,
		getBusinessEligibility,
		getCatalog,
		getCollections,
		productCreate,
		productDelete,
		productUpdate,
		catalogCreate,
		collectionCreate,
		collectionUpdate,
		collectionsDelete,
		productAppeal,
		collectionAppeal,
		ctwaAdAccountGetAccessTokenAndSessionCookies,
		updateBussinesProfile,
		updateCoverPhoto,
		removeCoverPhoto
	}
}
exports.makeBusinessSocket = makeBusinessSocket
