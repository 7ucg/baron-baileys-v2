'use strict'
Object.defineProperty(exports, '__esModule', { value: true })
exports.makePrivacySocket = void 0

const { executeWMexQuery } = require('./mex')

/**
 * MEX query IDs for privacy, status/profile, account/auth, and misc operations.
 * Source: assets/whatsapp-android-mex_client_persist_ids.json
 */
const PRIVACY_MEX_IDS = {
	// Privacy settings
	GET_SETTINGS: '32774292262215379', // GetPrivacySettingsQuery
	SET_SETTING: '26887749497493182', // SetPrivacySettingMutation
	UPDATE_CONTACT_LIST: '26375158178762799', // UpdatePrivacyContactListMutation
	GET_CONTACT_LIST: '25700444246275822', // GetPrivacyContactListQuery
	// Status / profile
	UPDATE_TEXT_STATUS: '25863197129975892', // UpdateTextStatus
	GET_TEXT_STATUS_LIST: '25741205615468935', // GetTextStatusList
	UPDATE_USER_STATUS: '7452341274886724', // UpdateUserStatus
	FETCH_USER_PICTURE: '24983561624604407', // FetchUserPictureInfo
	PROFILE_PICTURE_MUTATION: '24714239711610700', // ProfilePictureMutation
	// Account / auth
	ACCOUNT_LOGIN: '27298465499757127', // AccountLoginMutation
	ACCOUNT_LOGOUT: '26863447609979194', // AccountLogoutMutation
	MULTI_ACCOUNT_REVOKE: '25846242091639661', // MultiAccountRevokeAccount
	ADD_MULTI_ACCOUNT_LINK: '25502812266025193', // AddMultiAccountLink
	ADD_TRUSTED_DEVICE: '24522952587403287', // AddTrustedDeviceMutation
	GET_TRUSTED_DEVICES: '27391232653862770', // GetTrustedDevicesQuery
	UNTRUST_TRUSTED_DEVICE: '26574930682133620', // UntrustTrustedDeviceMutation
	DELETE_TRUSTED_DEVICE: '33867503889559538', // DeleteTrustedDeviceMutation
	// Misc
	MOBILE_CONFIG_FETCH: '25676911271914597', // MobileConfigFetchQuery
	NOTIFY_PUSH_NAME: '25900490552974543', // NotifyPushName
	CONTACT_INTEGRITY: '25924358997169495', // ContactIntegrityQuery
	BIZ_INTEGRITY: '25975613018777537', // BizIntegrityQuery
	LINKED_PROFILES_SET: '25013968611531010', // LinkedProfilesSet
	LINKED_PROFILES_REMOVE: '24537675509265525', // LinkedProfilesRemove
	LINKED_PROFILES_UPDATE: '24876967165297614', // LinkedProfilesUpdate
	MIGRATE_BLOCKLIST_LID: '25028600226770432', // MigrateBlocklistLid
	QR_CODE_SCAN: '26287165600869744' // QRCodeScan
}

const makePrivacySocket = sock => {
	const { query, generateMessageTag } = sock

	const mexQuery = (variables, queryId, dataPath) =>
		executeWMexQuery(variables, queryId, dataPath, query, generateMessageTag)

	// ── Privacy Settings ────────────────────────────────────────────────────

	/**
	 * Fetch all privacy settings via MEX.
	 * Confirmed from C24395AkT.java — variables: { users: [{ jid, privacy_features: [...] }] }
	 * dataPath: xwa2_fetch_wa_users (array of users, each with privacy_settings[])
	 *
	 * @param {string} jid - Own JID
	 * @param {string[]} [features] - Privacy features to fetch (default: all known)
	 */
	const getPrivacySettings = (jid, features = null) => {
		const users = [{ jid, ...(features ? { privacy_features: features } : {}) }]
		return mexQuery({ users }, PRIVACY_MEX_IDS.GET_SETTINGS, 'xwa2_fetch_wa_users')
	}

	/**
	 * Set a privacy setting via MEX.
	 * Confirmed from C24403Akb.java — variables: { feature, setting }
	 * dataPath: xwa2_privacy_feature_update
	 *
	 * Values are lowercase and case-sensitive on the wire (confirmed 2026-07-19 against
	 * WASmaxInPrivacyEnums / WAWebPrivacySettings) — NOT the uppercase values this doc used to list.
	 *
	 * Known features: "last" (last seen), "online", "profile" (photo), "status", "readreceipts",
	 *                 "groupadd" (who can add you to groups), "groupcreation", "calladd",
	 *                 "defense" (anti-scraping), "messages", "linked_profiles", "cover_photo",
	 *                 "dependentaccountmessages", "pix", "stickers"
	 *                 (the last 6 are business-account-only)
	 * Known settings: "all", "contacts", "contact_blacklist", "none" — most features.
	 *                 "online" only accepts "all" | "match_last_seen".
	 *                 "calladd" only accepts "all" | "contacts" | "known".
	 *                 "defense" only accepts "off" | "on_standard".
	 *
	 * @param {string} feature - Privacy feature name
	 * @param {string} setting - New value
	 */
	const setPrivacySetting = (feature, setting) =>
		mexQuery({ feature, setting }, PRIVACY_MEX_IDS.SET_SETTING, 'xwa2_privacy_feature_update')

	/**
	 * Update the contact list for a privacy setting (e.g. "GROUPS" with CONTACT_BLACKLIST).
	 * Confirmed from InteropPrivacySettingWithContactListUpdate pattern.
	 * dataPath: xwa2_privacy_contact_list_update
	 *
	 * @param {string} feature - Privacy feature
	 * @param {string} setting - "CONTACT_BLACKLIST" | "CONTACTS"
	 * @param {string[]} jids - List of JIDs to include in the list
	 */
	const updatePrivacyContactList = (feature, setting, jids) =>
		mexQuery(
			{ feature, setting, contacts: jids.map(jid => ({ jid })) },
			PRIVACY_MEX_IDS.UPDATE_CONTACT_LIST,
			'xwa2_privacy_contact_list_update'
		)

	/**
	 * Fetch the contact list for a privacy setting.
	 * dataPath: xwa2_privacy_contact_list
	 *
	 * @param {string} feature - Privacy feature
	 * @param {string} setting - "CONTACT_BLACKLIST" | "CONTACTS"
	 */
	const getPrivacyContactList = (feature, setting) =>
		mexQuery({ feature, setting }, PRIVACY_MEX_IDS.GET_CONTACT_LIST, 'xwa2_privacy_contact_list')

	// ── Status / Profile ───────────────────────────────────────────────────

	/**
	 * Update own text status (About/Evolved About) via MEX.
	 * Confirmed from C227219wi.java:
	 *   text_status_input: { text, emoji: { content } }
	 *   dataPath: xwa2_text_status_update
	 *
	 * @param {string} text - Status text
	 * @param {string} [emoji] - Optional emoji to attach
	 */
	const updateTextStatus = (text, emoji = null) => {
		const input = { text }
		if (emoji) input.emoji = { content: emoji }
		return mexQuery({ text_status_input: input }, PRIVACY_MEX_IDS.UPDATE_TEXT_STATUS, 'xwa2_text_status_update')
	}

	/**
	 * Fetch text statuses (About) for a list of JIDs via MEX.
	 * Confirmed from C227219wi.java:
	 *   input: [{ jid, last_update_time: null }]
	 *   dataPath: xwa2_text_status_list
	 *
	 * @param {string[]} jids - JIDs to fetch statuses for
	 * @param {number|null} [lastUpdateTime] - Only return statuses newer than this timestamp
	 */
	const getTextStatusList = (jids, lastUpdateTime = null) => {
		const input = jids.map(jid => ({ jid, last_update_time: lastUpdateTime }))
		return mexQuery({ input }, PRIVACY_MEX_IDS.GET_TEXT_STATUS_LIST, 'xwa2_text_status_list')
	}

	/**
	 * Update own user status string via MEX.
	 * Confirmed from UpdateUserStatus mutation — variables: { status }
	 * dataPath: xwa2_update_user_status
	 *
	 * @param {string} status - New status string
	 */
	const updateUserStatus = status => mexQuery({ status }, PRIVACY_MEX_IDS.UPDATE_USER_STATUS, 'xwa2_update_user_status')

	/**
	 * Fetch picture info for a user via MEX.
	 * dataPath: xwa2_fetch_user_picture_info
	 *
	 * @param {string} jid - JID to fetch picture info for
	 */
	const fetchUserPictureInfo = jid =>
		mexQuery({ jid }, PRIVACY_MEX_IDS.FETCH_USER_PICTURE, 'xwa2_fetch_user_picture_info')

	/**
	 * Set own profile picture via MEX.
	 * dataPath: xwa2_profile_picture_mutation
	 *
	 * @param {string} imageBase64 - Base64-encoded image data
	 * @param {'image'|'preview'} [type='image'] - Picture type
	 */
	const setProfilePictureMex = (imageBase64, type = 'image') =>
		mexQuery(
			{ input: { image: imageBase64, type } },
			PRIVACY_MEX_IDS.PROFILE_PICTURE_MUTATION,
			'xwa2_profile_picture_mutation'
		)

	// ── Account / Auth ─────────────────────────────────────────────────────

	/**
	 * Mark account as logged-in via MEX (companion device registration flow).
	 * Confirmed from LogoutManager.java:
	 *   input: { phone_number }
	 *   dataPath: xwa2_account_login
	 *
	 * @param {string} phoneNumber - Phone number (raw, e.g. "491234567890")
	 */
	const accountLogin = phoneNumber =>
		mexQuery({ input: { phone_number: phoneNumber } }, PRIVACY_MEX_IDS.ACCOUNT_LOGIN, 'xwa2_account_login')

	/**
	 * Mark account as logged-out via MEX.
	 * Confirmed from LogoutManager.java:
	 *   input: { phone_number, enabled_biometric }
	 *   dataPath: xwa2_account_logout
	 *
	 * @param {string} phoneNumber - Phone number
	 * @param {boolean} [enabledBiometric=false]
	 */
	const accountLogout = (phoneNumber, enabledBiometric = false) =>
		mexQuery(
			{ input: { phone_number: phoneNumber, enabled_biometric: enabledBiometric } },
			PRIVACY_MEX_IDS.ACCOUNT_LOGOUT,
			'xwa2_account_logout'
		)

	/**
	 * Add a multi-account link (secondary account) via MEX.
	 * Confirmed from AddMultiAccountLink mutation:
	 *   input: { phone_number }
	 *   dataPath: xwa2_add_multi_account_link
	 *
	 * @param {string} phoneNumber - Phone number of account to link
	 */
	const addMultiAccountLink = phoneNumber =>
		mexQuery(
			{ input: { phone_number: phoneNumber } },
			PRIVACY_MEX_IDS.ADD_MULTI_ACCOUNT_LINK,
			'xwa2_add_multi_account_link'
		)

	/**
	 * Add a trusted device (biometric/passkey) via MEX.
	 * Confirmed from RegTrustedDeviceGraphQLHelper.java:
	 *   device_id, device_name
	 *   dataPath: xwa2_add_trusted_device
	 *
	 * @param {string} deviceId - Device ID suffix
	 * @param {string} deviceName - Human-readable device name
	 */
	const addTrustedDevice = (deviceId, deviceName) =>
		mexQuery(
			{ device_id: deviceId, device_name: deviceName },
			PRIVACY_MEX_IDS.ADD_TRUSTED_DEVICE,
			'xwa2_add_trusted_device'
		)

	/**
	 * Fetch list of trusted devices for the account via MEX.
	 * dataPath: xwa2_get_trusted_devices
	 */
	const getTrustedDevices = () => mexQuery({}, PRIVACY_MEX_IDS.GET_TRUSTED_DEVICES, 'xwa2_get_trusted_devices')

	/**
	 * Untrust (remove) a trusted device via MEX.
	 * Confirmed from RegTrustedDeviceGraphQLHelper.java:
	 *   device_id, reason (default: "REREG")
	 *   dataPath: xwa2_untrust_trusted_device
	 *
	 * @param {string} deviceId - Device ID to remove
	 * @param {string} [reason='USER_INITIATED']
	 */
	const untrustTrustedDevice = (deviceId, reason = 'USER_INITIATED') =>
		mexQuery({ device_id: deviceId, reason }, PRIVACY_MEX_IDS.UNTRUST_TRUSTED_DEVICE, 'xwa2_untrust_trusted_device')

	/**
	 * Delete a trusted device entirely via MEX.
	 * dataPath: xwa2_delete_trusted_device
	 *
	 * @param {string} deviceId - Device ID to delete
	 */
	const deleteTrustedDevice = deviceId =>
		mexQuery({ device_id: deviceId }, PRIVACY_MEX_IDS.DELETE_TRUSTED_DEVICE, 'xwa2_delete_trusted_device')

	/**
	 * Revoke multi-account link for a secondary account via MEX.
	 * dataPath: xwa2_multi_account_revoke
	 *
	 * @param {string} accountJid - JID of the account to revoke
	 */
	const revokeMultiAccount = accountJid =>
		mexQuery({ account_jid: accountJid }, PRIVACY_MEX_IDS.MULTI_ACCOUNT_REVOKE, 'xwa2_multi_account_revoke')

	// ── Misc ───────────────────────────────────────────────────────────────

	/**
	 * Fetch mobile config via MEX.
	 * Confirmed from C28889Clt.java:
	 *   api_version, ep_refresh_id, flags
	 *   dataPath: xwa2_mobile_config_fetch
	 *
	 * @param {number} [apiVersion=0]
	 * @param {number} [epRefreshId=0]
	 * @param {string} [flags='']
	 */
	const fetchMobileConfig = (apiVersion = 0, epRefreshId = 0, flags = '') =>
		mexQuery(
			{ api_version: apiVersion, ep_refresh_id: epRefreshId, flags },
			PRIVACY_MEX_IDS.MOBILE_CONFIG_FETCH,
			'xwa2_mobile_config_fetch'
		)

	/**
	 * Notify group members of your push name via MEX.
	 * Confirmed from C128275fj.java:
	 *   input: { group_jid, participants: [{ jid, push_name }] }
	 *   dataPath: xwa2_notify_push_name
	 *
	 * @param {string} groupJid - Group JID
	 * @param {{ jid: string, pushName: string }[]} participants
	 */
	const notifyPushName = (groupJid, participants) =>
		mexQuery(
			{
				input: {
					group_jid: groupJid,
					participants: participants.map(({ jid, pushName }) => ({ jid, push_name: pushName }))
				}
			},
			PRIVACY_MEX_IDS.NOTIFY_PUSH_NAME,
			'xwa2_notify_push_name'
		)

	/**
	 * Run a contact integrity check via MEX.
	 * Confirmed from RunnableC24106Aep.java — uses xwa2_fetch_wa_users path.
	 * use_case: "START_CHAT_CONTEXT"
	 *
	 * @param {string[]} jids - JIDs to check
	 * @param {string} [useCase='START_CHAT_CONTEXT']
	 */
	const contactIntegrityQuery = (jids, useCase = 'START_CHAT_CONTEXT') =>
		mexQuery(
			{ users: jids.map(jid => ({ jid })), use_case: useCase },
			PRIVACY_MEX_IDS.CONTACT_INTEGRITY,
			'xwa2_fetch_wa_users'
		)

	/**
	 * Run a business integrity check via MEX.
	 * Confirmed from BizIntegrityQuery — variables: { users: [{ jid }] }
	 * dataPath: xwa2_fetch_wa_users
	 *
	 * @param {string[]} jids - Business JIDs to check
	 */
	const bizIntegrityQuery = jids =>
		mexQuery({ users: jids.map(jid => ({ jid })) }, PRIVACY_MEX_IDS.BIZ_INTEGRITY, 'xwa2_fetch_wa_users')

	/**
	 * Set linked social profiles (FB/IG) via MEX.
	 * Confirmed from C24386Ak3.java:
	 *   profiles: [{ type: "FB"|"IG", username|vid, encrypted_metadata?, user_info? }]
	 *   dataPath: xwa2_linked_profiles_set
	 *
	 * @param {{ type: 'FB'|'IG', username?: string, vid?: string }[]} profiles
	 */
	const linkedProfilesSet = profiles => {
		const mapped = profiles.map(p => {
			const entry = { type: p.type }
			if (p.vid) entry.vid = p.vid
			else if (p.username) entry.username = p.username
			return entry
		})
		return mexQuery({ profiles: mapped }, PRIVACY_MEX_IDS.LINKED_PROFILES_SET, 'xwa2_linked_profiles_set')
	}

	/**
	 * Remove linked social profiles via MEX.
	 * dataPath: xwa2_linked_profiles_remove
	 *
	 * @param {('FB'|'IG')[]} types - Profile types to remove
	 */
	const linkedProfilesRemove = types =>
		mexQuery(
			{ profiles: types.map(type => ({ type })) },
			PRIVACY_MEX_IDS.LINKED_PROFILES_REMOVE,
			'xwa2_linked_profiles_remove'
		)

	/**
	 * Update linked social profile visibility/settings via MEX.
	 * Confirmed from LinkedProfilesUpdate mutation:
	 *   profiles: [{ type, show_on_profile }]
	 *   dataPath: xwa2_linked_profiles_update
	 *
	 * @param {{ type: 'FB'|'IG', showOnProfile: boolean }[]} profiles
	 */
	const linkedProfilesUpdate = profiles =>
		mexQuery(
			{ profiles: profiles.map(({ type, showOnProfile }) => ({ type, show_on_profile: showOnProfile })) },
			PRIVACY_MEX_IDS.LINKED_PROFILES_UPDATE,
			'xwa2_linked_profiles_update'
		)

	/**
	 * Migrate blocklist to LID addressing via MEX.
	 * Confirmed from C8Eu.java:
	 *   input: { blocklist: [{ jid }], dhash, dirty_ack }
	 *   dataPath: xwa2_migrate_blocklist_lid
	 *
	 * @param {string[]} jids - Blocked JIDs to migrate
	 * @param {string} [dhash=''] - Current blocklist hash
	 * @param {boolean} [dirtyAck=true]
	 */
	const migrateBlocklistLid = (jids, dhash = '', dirtyAck = true) =>
		mexQuery(
			{
				input: {
					blocklist: jids.map(jid => ({ jid })),
					dhash,
					dirty_ack: dirtyAck
				}
			},
			PRIVACY_MEX_IDS.MIGRATE_BLOCKLIST_LID,
			'xwa2_migrate_blocklist_lid'
		)

	/**
	 * Scan a QR code via MEX (used for linking companion devices).
	 * dataPath: xwa2_qr_code_scan
	 *
	 * @param {string} qrData - Raw QR code data string
	 */
	const qrCodeScan = qrData => mexQuery({ qr_data: qrData }, PRIVACY_MEX_IDS.QR_CODE_SCAN, 'xwa2_qr_code_scan')

	return {
		...sock,
		// Privacy
		getPrivacySettings,
		setPrivacySetting,
		updatePrivacyContactList,
		getPrivacyContactList,
		// Status / profile
		updateTextStatus,
		getTextStatusList,
		updateUserStatus,
		fetchUserPictureInfo,
		setProfilePictureMex,
		// Account / auth
		accountLogin,
		accountLogout,
		addMultiAccountLink,
		addTrustedDevice,
		getTrustedDevices,
		untrustTrustedDevice,
		deleteTrustedDevice,
		revokeMultiAccount,
		// Misc
		fetchMobileConfig,
		notifyPushName,
		contactIntegrityQuery,
		bizIntegrityQuery,
		linkedProfilesSet,
		linkedProfilesRemove,
		linkedProfilesUpdate,
		migrateBlocklistLid,
		qrCodeScan,
		PRIVACY_MEX_IDS
	}
}

exports.makePrivacySocket = makePrivacySocket
