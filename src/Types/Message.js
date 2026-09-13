'use strict'
Object.defineProperty(exports, '__esModule', { value: true })
exports.WAMessageAddressingMode =
	exports.WAMessageStatus =
	exports.WAMessageStubType =
	exports.WAProto =
	exports.ScheduledCallType =
	exports.ScheduledCallEditType =
	exports.CallLogOutcome =
	exports.CallLogType =
	exports.SplitPaymentStatus =
	exports.P2PPaymentReminderFrequency =
	exports.P2PPaymentReminderState =
	exports.ConditionalRevealType =
	exports.EventResponseType =
	exports.PrivateProcessingStatus =
	exports.PaymentInfoStatus =
	exports.PaymentInfoTxnStatus =
	exports.VideoQuality =
	exports.MediaVisibility =
	exports.HistorySyncType =
		void 0
const index_js_1 = require('../../WAProto/index.js')
Object.defineProperty(exports, 'WAProto', {
	enumerable: true,
	get: function () {
		return index_js_1.proto
	}
})
exports.WAMessageStubType = index_js_1.proto.WebMessageInfo.StubType
exports.WAMessageStatus = index_js_1.proto.WebMessageInfo.Status

exports.ScheduledCallType = index_js_1.proto.Message.ScheduledCallCreationMessage.CallType
exports.ScheduledCallEditType = index_js_1.proto.Message.ScheduledCallEditMessage.EditType
exports.CallLogOutcome = index_js_1.proto.Message.CallLogMessage.CallOutcome
exports.CallLogType = index_js_1.proto.Message.CallLogMessage.CallType
exports.SplitPaymentStatus = index_js_1.proto.Message.SplitPaymentParticipant.SplitPaymentStatus
exports.P2PPaymentReminderFrequency = index_js_1.proto.Message.P2PPaymentReminderNotification?.ReminderFrequency
exports.P2PPaymentReminderState = index_js_1.proto.Message.P2PPaymentReminderNotification?.ReminderState
exports.ConditionalRevealType = index_js_1.proto.Message.ConditionalRevealMessage.ConditionalRevealMessageType
exports.EventResponseType = index_js_1.proto.Message.EventResponseMessage.EventResponseType
exports.PrivateProcessingStatus =
	index_js_1.proto.SyncActionValue.PrivateProcessingSettingAction.PrivateProcessingStatus
exports.BusinessBroadcastCampaignStatus = index_js_1.proto.SyncActionValue.BusinessBroadcastCampaignStatus
exports.BusinessBroadcastCampaignBBProStatus = index_js_1.proto.SyncActionValue.BusinessBroadcastCampaignBBProStatus
exports.PaymentInfoStatus = index_js_1.proto.PaymentInfo.Status
exports.PaymentInfoTxnStatus = index_js_1.proto.PaymentInfo.TxnStatus
exports.VideoQuality = index_js_1.proto.ProcessedVideo.VideoQuality
exports.MediaVisibility = index_js_1.proto.MediaVisibility
exports.HistorySyncType = index_js_1.proto.HistorySync.HistorySyncType
exports.KeepType = index_js_1.proto.KeepType
exports.BotFeedbackKind = index_js_1.proto.BotFeedbackMessage.BotFeedbackKind
exports.CloudAPIThreadControl = index_js_1.proto.Message.CloudAPIThreadControlNotification.CloudAPIThreadControl
exports.MessageAddOnType = index_js_1.proto.MessageAddOn.MessageAddOnType
exports.ProtocolMessageType = index_js_1.proto.Message.ProtocolMessage.Type
exports.BCallMediaType = index_js_1.proto.Message.BCallMessage.MediaType
exports.SecretEncType = index_js_1.proto.Message.SecretEncryptedMessage.SecretEncType
exports.MediaRetryResultType = index_js_1.proto.MediaRetryNotification.ResultType
exports.StatusAttributionType = index_js_1.proto.StatusAttribution.Type
exports.ForwardOrigin = index_js_1.proto.ContextInfo.ForwardOrigin
exports.StatusAudienceType = index_js_1.proto.ContextInfo.StatusAudienceMetadata.AudienceType
exports.VideoSourceType = index_js_1.proto.Message.VideoMessage.VideoSourceType
exports.PollType = index_js_1.proto.Message.PollType
exports.BotCapabilityType = index_js_1.proto.BotCapabilityMetadata.BotCapabilityType
exports.AssociationType = index_js_1.proto.MessageAssociation.AssociationType
exports.ThreadType = index_js_1.proto.ThreadID.ThreadType
exports.CarouselCardType = index_js_1.proto.Message.InteractiveMessage.CarouselMessage.CarouselCardType
exports.ImageSourceType = index_js_1.proto.Message.ImageMessage.ImageSourceType
exports.BotSessionSource = index_js_1.proto.BotSessionSource
exports.BotReminderAction = index_js_1.proto.BotReminderMetadata.ReminderAction
exports.BotReminderFrequency = index_js_1.proto.BotReminderMetadata.ReminderFrequency
exports.BotPluginType = index_js_1.proto.BotPluginMetadata.PluginType
exports.BotPluginSearchProvider = index_js_1.proto.BotPluginMetadata.SearchProvider
exports.BizInteractionPillType = index_js_1.proto.ContextInfo.BusinessInteractionPills.PillType
exports.PeerDataOperationRequestType = index_js_1.proto.Message.PeerDataOperationRequestType
exports.SocialMediaPostType = index_js_1.proto.Message.LinkPreviewMetadata.SocialMediaPostType
exports.AIRichResponseMessageType = index_js_1.proto.AIRichResponseMessageType
exports.AIRichResponseSubMessageType = index_js_1.proto.AIRichResponseSubMessageType
exports.AISubscriptionRequestType = index_js_1.proto.AISubscriptionRequestType
exports.BotMetricsEntryPoint = index_js_1.proto.BotMetricsEntryPoint
exports.BotMetricsThreadEntryPoint = index_js_1.proto.BotMetricsThreadEntryPoint
exports.MediaKeyDomain = index_js_1.proto.MediaKeyDomain
exports.SessionTransparencyType = index_js_1.proto.SessionTransparencyType
exports.ADVEncryptionType = index_js_1.proto.ADVEncryptionType
exports.PlaceholderMessageType = index_js_1.proto.Message.PlaceholderMessage.PlaceholderType
exports.SecretEncEncType = index_js_1.proto.Message.SecretEncryptedMessage.SecretEncType
exports.ImageMessageSourceType = index_js_1.proto.Message.ImageMessage.ImageSourceType
exports.VideoMessageSourceType = index_js_1.proto.Message.VideoMessage.VideoSourceType
exports.NativeFlowActionType =
	index_js_1.proto.Message.InteractiveResponseMessage?.NativeFlowResponseMessage?.NativeFlowActionType
exports.InteractiveAnnotationType = index_js_1.proto.HydratedAnnotatedBotMessage?.HydratedAnnotatedMessageType

var WAMessageAddressingMode
;(function (WAMessageAddressingMode) {
	WAMessageAddressingMode['PN'] = 'pn'
	WAMessageAddressingMode['LID'] = 'lid'
})(WAMessageAddressingMode || (exports.WAMessageAddressingMode = WAMessageAddressingMode = {}))
