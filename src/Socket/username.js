'use strict'
Object.defineProperty(exports, '__esModule', { value: true })
exports.makeUsernameSocket = void 0

const { executeWMexQuery } = require('./mex')
const { USyncQuery, USyncUser } = require('../WAUSync')
const { makeNewsletterSocket } = require('./newsletter')

/**
 * w:mex query IDs for username operations.
 *
 * Source: whatsapp-android-mex_client_persist_ids.json (WA 2.26.26.4 APK assets)
 * Cross-checked: live Frida capture on real device (wa-logger-2.26.26.4.js, 2026-06-30)
 */
const USERNAME_QUERY_IDS = {
	CHECK: '26122779627399568', // UsernameCheck (WAWebMexUsernameAvailabilityQuery) — verified 2026-08-28
	CHECK_MULTI: '27134626522840286', // UsernameCheckMulti
	SET: '27108705368767936', // UsernameSet
	GET: '25347099718279209', // UsernameGet (WAWebMexGetUsernameJobQuery) — verified 2026-08-28
	GET_RECOMMENDATIONS: '26077456248616957', // UsernameGetRecommendationsQuery
	PIN_SET: '9749436995157074' // UsernamePinSet (WAWebMexSetUsernameKeyJobMutation) — verified 2026-08-28
}

/**
 * Source enum values from EnumC141106Vn (UsernameCheck result)
 * and EnumC141056Vi (rejection reasons) confirmed via C164057Wg.java
 */
const USERNAME_CHECK_RESULT = {
	SUCCESS: 'SUCCESS',
	INVALID: 'INVALID'
}

const USERNAME_SOURCE = {
	FB: 'FB',
	IG: 'IG',
	USER_INPUT: 'USER_INPUT',
	SUGGESTION: 'SUGGESTION'
}

const makeUsernameSocket = config => {
	const sock = makeNewsletterSocket(config)
	const { query, generateMessageTag, executeUSyncQuery } = sock

	const mexQuery = (variables, queryId, dataPath) =>
		executeWMexQuery(variables, queryId, dataPath, query, generateMessageTag)

	/**
	 * Check whether a username is available.
	 *
	 * @param {string} username - The @username to check (without @)
	 * @param {boolean} includeSuggestions - Request alternative suggestions when taken
	 * @returns {object}
	 *   On success:   { available: true, username }
	 *   On taken:     { available: false, username, suggestions: string[], rejectionReasons: string[], suggestionsEligible: boolean }
	 *   On rate-limit: throws Boom with statusCode 429
	 *
	 * Confirmed fields from C164057Wg.java:
	 *   data.xwa2_username_check.result   → 'SUCCESS' | 'INVALID'
	 *   data.xwa2_username_check.suggestions
	 *   data.xwa2_username_check.rejection_reasons
	 *   data.xwa2_username_check.suggestions_eligible
	 */
	const checkUsername = async (username, includeSuggestions = true, sessionId) => {
		// session_id ties this check to the subsequent set step — caller can pass one in
		// so both use the same UUID (confirmed from live WA 2.26.26.4 capture).
		const session_id = sessionId || require('crypto').randomUUID()
		const data = await mexQuery(
			{
				username,
				include_suggestions: includeSuggestions,
				session_id,
				source: USERNAME_SOURCE.USER_INPUT
			},
			USERNAME_QUERY_IDS.CHECK,
			'xwa2_username_check'
		)
		if (data?.result === USERNAME_CHECK_RESULT.SUCCESS) {
			return { available: true, username, session_id }
		}
		return {
			available: false,
			username,
			session_id,
			suggestions: data?.suggestions ?? [],
			rejectionReasons: data?.rejection_reasons ?? [],
			suggestionsEligible: data?.suggestions_eligible ?? true
		}
	}

	/**
	 * Set your own username.
	 *
	 * @param {string} username - The username to set (without @)
	 * @param {object} options
	 *   @param {string} [options.source] - 'USER_INPUT' | 'FB' | 'IG' | 'SUGGESTION'
	 *   @param {string} [options.sessionId] - Optional session tracking ID
	 *   @param {string} [options.pin] - Optional PIN for protected usernames
	 *
	 * Confirmed variables from C1568872p.java A00():
	 *   username, reserved (bool), session_id, source, pin
	 */
	const setUsername = async (username, options = {}) => {
		const { source = USERNAME_SOURCE.USER_INPUT, sessionId, pin } = options
		// session_id links the check and set steps — generate one if caller doesn't supply it.
		// reserved:true confirmed from live WA 2.26.26.4 capture (was wrongly false before).
		const session_id = sessionId || require('crypto').randomUUID()
		const variables = {
			username,
			reserved: true,
			source,
			session_id,
			...(pin ? { pin } : {})
		}
		return mexQuery(variables, USERNAME_QUERY_IDS.SET, 'xwa2_username_set')
	}

	/**
	 * Delete (unset) your own username.
	 *
	 * Confirmed from C1568872p.java:
	 *   str4 = str == null ? "delete" : "set"
	 *   → sending username=null triggers the delete path on the server.
	 */
	const deleteUsername = async () => {
		return mexQuery({ username: null }, USERNAME_QUERY_IDS.SET, 'xwa2_username_delete')
	}

	/**
	 * Get your own current username.
	 *
	 * Confirmed from C1568872p.java A02():
	 *   AbstractC41851rT.A0L(AbstractC130045pa.A0T(), C1363664w.class, "UsernameGet", false)
	 */
	const getMyUsername = async () => {
		const data = await mexQuery({}, USERNAME_QUERY_IDS.GET, 'xwa2_username_get')
		return data?.username ?? null
	}

	/**
	 * Set or delete the PIN that protects your username.
	 *
	 * @param {string|null} pin - New PIN, or null to delete the PIN
	 *
	 * Confirmed from MexUsernamePinProtocolApi.java:
	 *   operation "UsernamePinSet", variable "pin"
	 *   pin=null triggers the "delete" path on the server.
	 */
	const setUsernamePin = async pin => {
		// pin=null → delete PIN (server interprets empty/null variables as delete)
		const variables = pin != null ? { pin } : {}
		return mexQuery(variables, USERNAME_QUERY_IDS.PIN_SET, 'xwa2_username_pin_set')
	}

	/**
	 * Look up a contact by their @username via USync.
	 *
	 * Confirmed via USyncContactProtocol.getUserElement():
	 *   { tag: 'contact', attrs: { username, pin? } }
	 *
	 * @param {string} username - The username to look up (without @)
	 * @param {string} [pin] - Optional PIN if the username is PIN-protected
	 * @returns {{ jid, lid?, contact: boolean }|null}
	 */
	const findUserByUsername = async (username, pin) => {
		const usyncQuery = new USyncQuery().withContactProtocol()
		const user = new USyncUser().withUsername(username)
		if (pin) user.withUsernameKey(pin)
		usyncQuery.withUser(user)
		const result = await executeUSyncQuery(usyncQuery)
		if (!result?.list?.length) return null
		const entry = result.list[0]
		return {
			jid: entry.id,
			contact: entry.contact ?? false
		}
	}

	/**
	 * Fetch the username of one or more contacts by their JID.
	 * Uses USync with the username protocol.
	 *
	 * @param {...string} jids - One or more JIDs
	 * @returns {Array<{ id, username: string|null }>}
	 */
	const fetchContactUsernames = async (...jids) => {
		const usyncQuery = new USyncQuery().withUsernameProtocol()
		for (const jid of jids) {
			usyncQuery.withUser(new USyncUser().withId(jid))
		}
		const result = await executeUSyncQuery(usyncQuery)
		return result?.list ?? []
	}

	/**
	 * Check multiple usernames for availability at once.
	 * @param {string[]} usernames - Array of usernames (without @)
	 */
	const checkUsernameMulti = async usernames => {
		const data = await mexQuery({ usernames }, USERNAME_QUERY_IDS.CHECK_MULTI, 'xwa2_username_check_multi')
		return data
	}

	/**
	 * Fetch username recommendations for the current user.
	 * @param {string} [source] - Source hint: 'FB' | 'IG' | 'USER_INPUT'
	 */
	const getUsernameRecommendations = async (source = null) => {
		const variables = {}
		if (source) variables.source = source
		return mexQuery(variables, USERNAME_QUERY_IDS.GET_RECOMMENDATIONS, 'xwa2_username_get_recommendations')
	}

	return {
		...sock,
		checkUsername,
		checkUsernameMulti,
		setUsername,
		deleteUsername,
		getMyUsername,
		getUsernameRecommendations,
		setUsernamePin,
		findUserByUsername,
		fetchContactUsernames,
		USERNAME_QUERY_IDS,
		USERNAME_CHECK_RESULT,
		USERNAME_SOURCE
	}
}

exports.makeUsernameSocket = makeUsernameSocket
