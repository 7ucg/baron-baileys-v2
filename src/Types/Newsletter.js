'use strict'
Object.defineProperty(exports, '__esModule', { value: true })
exports.QueryIds =
	exports.XWAPaths =
	exports.NewsletterReactionSetting =
	exports.NewsletterState =
	exports.NewsletterRole =
		void 0
var NewsletterRole
;(function (NewsletterRole) {
	NewsletterRole['SUBSCRIBER'] = 'SUBSCRIBER'
	NewsletterRole['ADMIN'] = 'ADMIN'
	NewsletterRole['OWNER'] = 'OWNER'
	NewsletterRole['GUEST'] = 'GUEST'
})(NewsletterRole || (exports.NewsletterRole = NewsletterRole = {}))
var NewsletterState
;(function (NewsletterState) {
	NewsletterState['ACTIVE'] = 'ACTIVE'
	NewsletterState['SUSPENDED'] = 'SUSPENDED'
	NewsletterState['GEO_SUSPENDED'] = 'GEO_SUSPENDED'
	NewsletterState['UNKNOWN'] = 'UNKNOWN'
})(NewsletterState || (exports.NewsletterState = NewsletterState = {}))
var NewsletterReactionSetting
;(function (NewsletterReactionSetting) {
	NewsletterReactionSetting['ALLOWLIST'] = 'ALLOWLIST'
	NewsletterReactionSetting['BLOCKLIST'] = 'BLOCKLIST'
	NewsletterReactionSetting['NONE'] = 'NONE'
})(NewsletterReactionSetting || (exports.NewsletterReactionSetting = NewsletterReactionSetting = {}))
var XWAPaths
;(function (XWAPaths) {
	XWAPaths['xwa2_newsletter_create'] = 'xwa2_newsletter_create'
	// stale, kept only for backwards references — server no longer returns these keys, use _followers/_admin_demote below
	XWAPaths['xwa2_newsletter_subscribers'] = 'xwa2_newsletter_subscribers'
	XWAPaths['xwa2_newsletter_followers'] = 'xwa2_newsletter_followers'
	XWAPaths['xwa2_newsletter_view'] = 'xwa2_newsletter_view'
	XWAPaths['xwa2_newsletter_metadata'] = 'xwa2_newsletter'
	XWAPaths['xwa2_newsletter_admin_count'] = 'xwa2_newsletter_admin'
	XWAPaths['xwa2_newsletter_mute_v2'] = 'xwa2_newsletter_mute_v2'
	XWAPaths['xwa2_newsletter_unmute_v2'] = 'xwa2_newsletter_unmute_v2'
	XWAPaths['xwa2_newsletter_follow'] = 'xwa2_newsletter_follow'
	XWAPaths['xwa2_newsletter_unfollow'] = 'xwa2_newsletter_unfollow'
	XWAPaths['xwa2_newsletter_change_owner'] = 'xwa2_newsletter_change_owner'
	XWAPaths['xwa2_newsletter_demote'] = 'xwa2_newsletter_demote'
	XWAPaths['xwa2_newsletter_admin_demote'] = 'xwa2_newsletter_admin_demote'
	XWAPaths['xwa2_newsletter_delete_v2'] = 'xwa2_newsletter_delete_v2'
	XWAPaths['xwa2_newsletter_join_v2'] = 'xwa2_newsletter_join_v2'
	XWAPaths['xwa2_newsletter_leave_v2'] = 'xwa2_newsletter_leave_v2'
	XWAPaths['xwa2_fetch_account_reachout_timelock'] = 'xwa2_fetch_account_reachout_timelock'
	XWAPaths['xwa2_message_capping_info'] = 'xwa2_message_capping_info'
	// Newsletter admin/invite paths
	XWAPaths['xwa2_newsletter_admin_invite_create'] = 'xwa2_newsletter_admin_invite_create'
	XWAPaths['xwa2_newsletter_admin_invite_revoke'] = 'xwa2_newsletter_admin_invite_revoke'
	XWAPaths['xwa2_newsletter_admin_invite_accept'] = 'xwa2_newsletter_admin_invite_accept'
	XWAPaths['xwa2_newsletter_admin'] = 'xwa2_newsletter_admin'
	XWAPaths['xwa2_newsletter_admin_profile_update'] = 'xwa2_newsletter_admin_profile_update'
	// Newsletter directory/search paths
	XWAPaths['xwa2_newsletters_directory_list'] = 'xwa2_newsletters_directory_list'
	XWAPaths['xwa2_newsletters_directory_search'] = 'xwa2_newsletters_directory_search'
	XWAPaths['xwa2_newsletters_directory_category_preview'] = 'xwa2_newsletters_directory_category_preview'
	XWAPaths['xwa2_newsletters_search'] = 'xwa2_newsletters_search'
	XWAPaths['xwa2_newsletters_recommended'] = 'xwa2_newsletters_recommended'
	XWAPaths['xwa2_newsletters_similar'] = 'xwa2_newsletters_similar'
	XWAPaths['xwa2_newsletter_following'] = 'xwa2_newsletter_following'
	// Newsletter engagement paths
	XWAPaths['xwa2_newsletter_admin_insights'] = 'xwa2_newsletter_admin_insights'
	XWAPaths['xwa2_newsletters_poll_voter_list'] = 'xwa2_newsletters_poll_voter_list'
	XWAPaths['xwa2_newsletters_reaction_sender_list'] = 'xwa2_newsletters_reaction_sender_list'
	// Newsletter moderation
	XWAPaths['xwa2_newsletter_enforcements'] = 'xwa2_newsletter_enforcements'
	XWAPaths['xwa2_newsletter_user_reports'] = 'xwa2_newsletter_user_reports'
	XWAPaths['xwa2_newsletter_create_report_appeal'] = 'xwa2_newsletter_create_report_appeal'
	XWAPaths['xwa2_newsletter_link_preview_check'] = 'xwa2_newsletter_link_preview_check'
	XWAPaths['xwa2_newsletter_update_verification'] = 'xwa2_newsletter_update_verification'
	XWAPaths['xwa2_newsletter_label_paid_partnership'] = 'xwa2_newsletter_label_paid_partnership'
	// Newsletter log/user
	XWAPaths['xwa2_newsletter_log_exposures'] = 'xwa2_newsletter_log_exposures'
	XWAPaths['xwa2_newsletter_update_user_setting'] = 'xwa2_newsletter_update_user_setting'
	XWAPaths['xwa2_newsletter_create_verified'] = 'xwa2_newsletter_create_verified'
	XWAPaths['xwa2_newsletter_ranking_features'] = 'xwa2_newsletter_ranking_features'
	XWAPaths['xwa2_newsletter_question_response_state_update'] = 'xwa2_newsletter_question_response_state_update'
	// Wamo paths
	XWAPaths['xwa2_wamo_afs_age_collection'] = 'xwa2_wamo_afs_age_collection'
	XWAPaths['xwa2_wamo_asset_collection'] = 'xwa2_wamo_asset_collection'
	XWAPaths['xwa2_wamo_fetch_adhoc_notice_by_id'] = 'xwa2_wamo_fetch_adhoc_notice_by_id'
	XWAPaths['xwa2_wamo_fetch_identity_token'] = 'xwa2_wamo_fetch_identity_token'
	XWAPaths['xwa2_wamo_sub_get_compliance_info'] = 'xwa2_wamo_sub_get_compliance_info'
	XWAPaths['xwa2_wamo_user_id_version'] = 'xwa2_wamo_user_id_version'
	XWAPaths['xwa2_wamo_set_user_id_version'] = 'xwa2_wamo_set_user_id_version'
})(XWAPaths || (exports.XWAPaths = XWAPaths = {}))
var QueryIds
;(function (QueryIds) {
	// Newsletter core
	// IDs below marked "verified 2026-07-19" were cross-checked against a live WA Web
	// graphql module dump; the rest are unverified and may also be stale.
	QueryIds['CREATE'] = '25149874324715067' // NewsletterCreate — verified 2026-07-19
	QueryIds['CREATE_VERIFIED'] = '27777918425146464' // NewsletterCreateVerified
	QueryIds['UPDATE_METADATA'] = '27150690864552229' // NewsletterMetadataUpdate
	QueryIds['METADATA'] = '26629010453445271' // NewsletterMetadata
	QueryIds['SUBSCRIBERS'] = '27472091235714801' // NewsletterFollowers — verified 2026-07-19
	QueryIds['FOLLOW'] = '24404358912487870' // NewsletterJoin — verified 2026-07-19
	QueryIds['LEAVE'] = '9767147403369991' // NewsletterLeave — verified 2026-07-19
	QueryIds['UNFOLLOW'] = '9767147403369991' // NewsletterLeave (unfollow == leave) — verified 2026-07-19
	QueryIds['MUTE'] = '25033614912931367' // NewsletterHide
	QueryIds['UNMUTE'] = '24551592861177484' // NewsletterUnhide
	QueryIds['ADMIN_COUNT'] = '27579307995002556' // NewslettersAdminCapabilitiesQuery
	QueryIds['CHANGE_OWNER'] = '24737692515842078' // NewsletterChangeOwner
	QueryIds['DEMOTE'] = '9880997548630971' // NewsletterAdminDemote — verified 2026-07-19
	QueryIds['DELETE'] = '30062808666639665' // NewsletterDelete — verified 2026-07-19
	QueryIds['REACHOUT_TIMELOCK'] = '25627902213558773' // FetchReachoutTimelockQuery
	QueryIds['MESSAGE_CAPPING_INFO'] = '37491736743758664' // XWA2MessageCappingInfoQuery
	QueryIds['UPDATE_USER_SETTING'] = '24935528202764688' // NewsletterUpdateUserSetting
	// Newsletter admin/invite
	QueryIds['ADMIN_INVITE'] = '26278681041745438' // NewsletterAdminInvite
	QueryIds['ADMIN_INVITE_REVOKE'] = '24369392486051948' // NewsletterAdminInviteRevoke
	QueryIds['ADMIN_INVITE_ACCEPT'] = '24934958956134858' // NewsletterAcceptAdminInvite
	QueryIds['ADMIN_METADATA'] = '26882701001369256' // NewsletterAdminMetadataQuery
	QueryIds['ADMIN_PROFILE_UPDATE'] = '25959584293627630' // NewsletterAdminProfileUpdate
	// Newsletter directory/search
	QueryIds['DIRECTORY_LIST'] = '27480627564903390' // NewsletterDirectoryList
	QueryIds['DIRECTORY_SEARCH'] = '27887355094203575' // NewsletterDirectorySearch
	QueryIds['DIRECTORY_CATEGORY_PREVIEW'] = '27432651036395658' // NewsletterDirectoryCategoryPreview
	QueryIds['SEARCH'] = '25909596625362196' // NewsletterSearch (no APK match — kept as-is)
	QueryIds['RECOMMENDED'] = '26638880912457992' // NewsletterRecommended
	QueryIds['SIMILAR'] = '36410329795280256' // NewsletterSimilar
	QueryIds['FOLLOWING_LIST'] = '26856957210673444' // NewsletterFollowing
	// Newsletter engagement
	QueryIds['INSIGHTS'] = '24672564052397921' // NewsletterInsights
	QueryIds['POLL_VOTER_LIST'] = '24803802869271956' // NewsletterPollVoterList
	QueryIds['REACTION_SENDERS_LIST'] = '25219734117717032' // NewsletterReactionSendersList
	QueryIds['QUESTION_RESPONSE_STATE_UPDATE'] = '24896618076668076' // NewsletterQuestionResponseStateUpdate
	QueryIds['LOG_EXPOSURES'] = '24606408825709914' // NewsletterLogExposures
	QueryIds['RANKING_FEATURES'] = '24742757908756088' // FetchNewsletterRankingFeatures
	// Newsletter moderation
	QueryIds['BLOCK_USER'] = '25106066249006236' // NewsletterBlockUser
	QueryIds['USER_REPORTS'] = '27149305681394065' // NewsletterUserReports
	QueryIds['CREATE_REPORT_APPEAL'] = '27792557363683798' // NewsletterCreateReportAppeal
	QueryIds['ENFORCEMENTS'] = '27089116857425014' // NewsletterEnforcements
	QueryIds['LINK_PREVIEW_CHECK'] = '24188786150796507' // NewsletterLinkPreviewCheck
	QueryIds['UPDATE_VERIFICATION'] = '27133493439664458' // NewsletterUpdateVerification
	QueryIds['LABEL_PAID_PARTNERSHIP'] = '26102375079404865' // NewsletterLabelPaidPartnership
	// Newsletter Wamo (paid subscription)
	QueryIds['WAMO_CHANGE_SUB'] = '25201342542835866' // NewsletterChangeWamoSub
	QueryIds['WAMO_ENABLE_SUB'] = '25122474967344830' // NewsletterEnableWamoSub
	QueryIds['WAMO_DISABLE_SUB'] = '31916794074578680' // NewsletterDisableWamoSub
	QueryIds['WAMO_AFS_AGE_COLLECTION'] = '25012618978387375' // WamoAfsAgeCollection
	QueryIds['WAMO_ASSET_COLLECTION'] = '24347085218298773' // WamoAssetCollection
	QueryIds['WAMO_FETCH_ADHOC_NOTICE'] = '24758534413802422' // WamoFetchAdhocNoticeById
	QueryIds['WAMO_FETCH_IDENTITY_TOKEN'] = '24677346488597665' // WamoFetchIdentityToken
	QueryIds['WAMO_SUB_COMPLIANCE_INFO'] = '25105596879072480' // WamoSubGetComplianceInfo
	QueryIds['WAMO_USER_ID_VERSION'] = '24958410737155269' // WamoUserIdVersion
	QueryIds['WAMO_SET_USER_ID_VERSION'] = '8148672891859281' // SetWamoUserIdVersion
})(QueryIds || (exports.QueryIds = QueryIds = {}))
