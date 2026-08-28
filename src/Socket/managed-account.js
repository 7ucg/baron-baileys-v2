'use strict'
Object.defineProperty(exports, '__esModule', { value: true })
exports.makeManagedAccountSocket = void 0

const { executeWMexQuery } = require('./mex')

const MANAGED_ACCOUNT_MEX_IDS = {
	// Managed accounts (parental/family)
	QUERY: '27232244463035262', // ManagedAccountQuery
	INITIATE_LINKING: '26671873552498548', // ManagedAccountInitiateLinkingQuery
	VALIDATE_LINKING: '35449808311284430', // ManagedAccountValidateLinkingQuery
	ACCEPT_LINKING: '26708926155457677', // ManagedAccountAcceptLinkingMutation
	COMPLETE_LINKING: '26866501363013203', // ManagedAccountCompleteLinkingMutation
	REVOKE_LINKING: '27435058196100677', // ManagedAccountRevokeLinkingMutation
	SYNC_ACTIVITIES: '26594352680227840', // ManagedAccountSyncActivities
	UPDATE_PIN: '27653949584193082', // ManagedAccountUpdatePinMutation
	GET_SPONSOR_AGE_VERIFICATION: '26433623289634522', // ManagedAccountGetSponsorAgeVerificationInfoQuery
	// Payments passkey
	PAYMENTS_PASSKEY_HAS_CREDENTIAL: '36878915648418618', // PaymentsPasskeyHasCredential (WAWebMexPaymentsPasskeyHasCredentialJobQuery) — verified 2026-08-28
	PAYMENTS_PASSKEY_ENROLL_CHALLENGE: '25233109079721001', // PaymentsPasskeyEnrollChallengeMutation
	PAYMENTS_PASSKEY_ENROLL_VERIFY: '26563835863283058', // PaymentsPasskeyEnrollVerifyMutation
	PAYMENTS_PASSKEY_REGISTER_FINISH: '26658791263822236', // PaymentsPasskeyRegisterFinishMutation
	PAYMENTS_PASSKEY_AUTH_CHALLENGE: '26425370627105628', // PaymentsPasskeyAuthChallengeMutation
	PAYMENTS_PASSKEY_TOGGLE_ON: '25841989828834577', // PaymentsPasskeyToggleOnMutation
	PAYMENTS_PASSKEY_TOGGLE_OFF: '26267673096201391', // PaymentsPasskeyToggleOffMutation
	PAYMENTS_PASSKEY_TOGGLE_CHALLENGE: '26133062322993192', // PaymentsPasskeyToggleChallengeMutation
	PAYMENTS_PASSKEY_TOGGLE_CLEANUP: '26492078607084840', // PaymentsPasskeyToggleCleanupMutation
	PAYMENTS_PASSKEY_CLEANUP: '26538338805859092', // PaymentsPasskeyCleanupMutation
	PAYMENTS_IS_RECOVERABLE: '27351347491148282', // PaymentsIsAccountRecoverable
	// UPI onboarding (India payments)
	UPI_SEND_OTP: '25829794080022469', // UpiOnboardingSendOtpMutation
	UPI_VERIFY_OTP: '34104109149204669', // UpiOnboardingVerifyOtpQuery
	// IPLS (Identity-Preserving Linked Spaces)
	IPLS_HANDSHAKE_INIT: '25523747957257182', // IplsClientHandshakeInitRequest
	IPLS_CLIENT_HELLO: '25376330595367716', // IplsClientHelloPayload
	IPLSD_CLIENT_HELLO_V2: '26561780580105679', // IplsdClientHelloV2
	IPLSD_CLIENT_INIT_V2: '26547193874915344' // IplsdClientInitV2
}

const makeManagedAccountSocket = sock => {
	const { query, generateMessageTag } = sock

	const mexQuery = (variables, queryId, dataPath) =>
		executeWMexQuery(variables, queryId, dataPath, query, generateMessageTag)

	// ── Managed Accounts ─────────────────────────────────────────────────────

	const managedAccountQuery = jid => mexQuery({ jid }, MANAGED_ACCOUNT_MEX_IDS.QUERY, 'xwa2_managed_account')

	const managedAccountInitiateLinking = phoneNumber =>
		mexQuery(
			{ phone_number: phoneNumber },
			MANAGED_ACCOUNT_MEX_IDS.INITIATE_LINKING,
			'xwa2_managed_account_initiate_linking'
		)

	const managedAccountValidateLinking = (linkingToken, sponsorJid) =>
		mexQuery(
			{ linking_token: linkingToken, sponsor_jid: sponsorJid },
			MANAGED_ACCOUNT_MEX_IDS.VALIDATE_LINKING,
			'xwa2_managed_account_validate_linking'
		)

	const managedAccountAcceptLinking = linkingToken =>
		mexQuery(
			{ linking_token: linkingToken },
			MANAGED_ACCOUNT_MEX_IDS.ACCEPT_LINKING,
			'xwa2_managed_account_accept_linking'
		)

	const managedAccountCompleteLinking = linkingToken =>
		mexQuery(
			{ linking_token: linkingToken },
			MANAGED_ACCOUNT_MEX_IDS.COMPLETE_LINKING,
			'xwa2_managed_account_complete_linking'
		)

	const managedAccountRevokeLinking = sponsoredJid =>
		mexQuery(
			{ sponsored_jid: sponsoredJid },
			MANAGED_ACCOUNT_MEX_IDS.REVOKE_LINKING,
			'xwa2_managed_account_revoke_linking'
		)

	const managedAccountSyncActivities = (jid, lastSyncTime = null) => {
		const variables = { jid }
		if (lastSyncTime != null) variables.last_sync_time = lastSyncTime
		return mexQuery(variables, MANAGED_ACCOUNT_MEX_IDS.SYNC_ACTIVITIES, 'xwa2_managed_account_sync_activities')
	}

	const managedAccountUpdatePin = (oldPin, newPin) =>
		mexQuery(
			{ input: { old_pin: oldPin, new_pin: newPin } },
			MANAGED_ACCOUNT_MEX_IDS.UPDATE_PIN,
			'xwa2_managed_account_update_pin'
		)

	const managedAccountGetSponsorAgeVerification = sponsorJid =>
		mexQuery(
			{ sponsor_jid: sponsorJid },
			MANAGED_ACCOUNT_MEX_IDS.GET_SPONSOR_AGE_VERIFICATION,
			'xwa2_managed_account_sponsor_age_verification'
		)

	// ── Payments Passkey ─────────────────────────────────────────────────────

	const paymentsPasskeyHasCredential = () =>
		mexQuery({}, MANAGED_ACCOUNT_MEX_IDS.PAYMENTS_PASSKEY_HAS_CREDENTIAL, 'xwa2_payments_passkey_has_credential')

	const paymentsPasskeyEnrollChallenge = () =>
		mexQuery({}, MANAGED_ACCOUNT_MEX_IDS.PAYMENTS_PASSKEY_ENROLL_CHALLENGE, 'xwa2_payments_passkey_enroll_challenge')

	const paymentsPasskeyEnrollVerify = (credentialId, attestationObject, clientDataJson) =>
		mexQuery(
			{ credential_id: credentialId, attestation_object: attestationObject, client_data_json: clientDataJson },
			MANAGED_ACCOUNT_MEX_IDS.PAYMENTS_PASSKEY_ENROLL_VERIFY,
			'xwa2_payments_passkey_enroll_verify'
		)

	const paymentsPasskeyRegisterFinish = (credentialId, attestationObject, clientDataJson) =>
		mexQuery(
			{ credential_id: credentialId, attestation_object: attestationObject, client_data_json: clientDataJson },
			MANAGED_ACCOUNT_MEX_IDS.PAYMENTS_PASSKEY_REGISTER_FINISH,
			'xwa2_payments_passkey_register_finish'
		)

	const paymentsPasskeyAuthChallenge = credentialId =>
		mexQuery(
			{ credential_id: credentialId },
			MANAGED_ACCOUNT_MEX_IDS.PAYMENTS_PASSKEY_AUTH_CHALLENGE,
			'xwa2_payments_passkey_auth_challenge'
		)

	const paymentsPasskeyToggleOn = () =>
		mexQuery({}, MANAGED_ACCOUNT_MEX_IDS.PAYMENTS_PASSKEY_TOGGLE_ON, 'xwa2_payments_passkey_toggle_on')

	const paymentsPasskeyToggleOff = () =>
		mexQuery({}, MANAGED_ACCOUNT_MEX_IDS.PAYMENTS_PASSKEY_TOGGLE_OFF, 'xwa2_payments_passkey_toggle_off')

	const paymentsPasskeyToggleChallenge = credentialId =>
		mexQuery(
			{ credential_id: credentialId },
			MANAGED_ACCOUNT_MEX_IDS.PAYMENTS_PASSKEY_TOGGLE_CHALLENGE,
			'xwa2_payments_passkey_toggle_challenge'
		)

	const paymentsPasskeyToggleCleanup = () =>
		mexQuery({}, MANAGED_ACCOUNT_MEX_IDS.PAYMENTS_PASSKEY_TOGGLE_CLEANUP, 'xwa2_payments_passkey_toggle_cleanup')

	const paymentsPasskeyCleanup = () =>
		mexQuery({}, MANAGED_ACCOUNT_MEX_IDS.PAYMENTS_PASSKEY_CLEANUP, 'xwa2_payments_passkey_cleanup')

	const paymentsIsAccountRecoverable = () =>
		mexQuery({}, MANAGED_ACCOUNT_MEX_IDS.PAYMENTS_IS_RECOVERABLE, 'xwa2_payments_is_account_recoverable')

	// ── UPI onboarding ───────────────────────────────────────────────────────

	const upiSendOtp = phoneNumber =>
		mexQuery({ phone_number: phoneNumber }, MANAGED_ACCOUNT_MEX_IDS.UPI_SEND_OTP, 'xwa2_upi_send_otp')

	const upiVerifyOtp = (phoneNumber, otp) =>
		mexQuery({ phone_number: phoneNumber, otp }, MANAGED_ACCOUNT_MEX_IDS.UPI_VERIFY_OTP, 'xwa2_upi_verify_otp')

	// ── IPLS (Identity-Preserving Linked Spaces) ─────────────────────────────

	const iplsHandshakeInit = payload =>
		mexQuery({ payload }, MANAGED_ACCOUNT_MEX_IDS.IPLS_HANDSHAKE_INIT, 'xwa2_ipls_handshake_init')

	const iplsClientHello = payload =>
		mexQuery({ payload }, MANAGED_ACCOUNT_MEX_IDS.IPLS_CLIENT_HELLO, 'xwa2_ipls_client_hello')

	const iplsdClientHelloV2 = payload =>
		mexQuery({ payload }, MANAGED_ACCOUNT_MEX_IDS.IPLSD_CLIENT_HELLO_V2, 'xwa2_iplsd_client_hello_v2')

	const iplsdClientInitV2 = payload =>
		mexQuery({ payload }, MANAGED_ACCOUNT_MEX_IDS.IPLSD_CLIENT_INIT_V2, 'xwa2_iplsd_client_init_v2')

	return {
		...sock,
		// Managed accounts
		managedAccountQuery,
		managedAccountInitiateLinking,
		managedAccountValidateLinking,
		managedAccountAcceptLinking,
		managedAccountCompleteLinking,
		managedAccountRevokeLinking,
		managedAccountSyncActivities,
		managedAccountUpdatePin,
		managedAccountGetSponsorAgeVerification,
		// Payments passkey
		paymentsPasskeyHasCredential,
		paymentsPasskeyEnrollChallenge,
		paymentsPasskeyEnrollVerify,
		paymentsPasskeyRegisterFinish,
		paymentsPasskeyAuthChallenge,
		paymentsPasskeyToggleOn,
		paymentsPasskeyToggleOff,
		paymentsPasskeyToggleChallenge,
		paymentsPasskeyToggleCleanup,
		paymentsPasskeyCleanup,
		paymentsIsAccountRecoverable,
		// UPI
		upiSendOtp,
		upiVerifyOtp,
		// IPLS
		iplsHandshakeInit,
		iplsClientHello,
		iplsdClientHelloV2,
		iplsdClientInitV2,
		MANAGED_ACCOUNT_MEX_IDS
	}
}

exports.makeManagedAccountSocket = makeManagedAccountSocket
