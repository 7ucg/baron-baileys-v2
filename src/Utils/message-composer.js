'use strict'

const { proto } = require('../../WAProto/index.js')
const { generateMessageIDV2 } = require('./generics.js')
const { randomBytes, randomUUID } = require('crypto')

const JS_KEYWORDS = new Set([
	'import',
	'export',
	'from',
	'default',
	'as',
	'const',
	'let',
	'var',
	'function',
	'class',
	'extends',
	'new',
	'return',
	'if',
	'else',
	'for',
	'while',
	'do',
	'switch',
	'case',
	'break',
	'continue',
	'try',
	'catch',
	'finally',
	'throw',
	'async',
	'await',
	'yield',
	'typeof',
	'instanceof',
	'in',
	'of',
	'delete',
	'void',
	'true',
	'false',
	'null',
	'undefined',
	'NaN',
	'Infinity',
	'this',
	'super',
	'static',
	'get',
	'set',
	'debugger',
	'with'
])

const PYTHON_KEYWORDS = new Set([
	'import',
	'from',
	'as',
	'def',
	'class',
	'return',
	'if',
	'elif',
	'else',
	'for',
	'while',
	'break',
	'continue',
	'try',
	'except',
	'finally',
	'raise',
	'with',
	'yield',
	'lambda',
	'pass',
	'del',
	'global',
	'nonlocal',
	'assert',
	'True',
	'False',
	'None',
	'and',
	'or',
	'not',
	'in',
	'is',
	'async',
	'await',
	'self',
	'print'
])

const LANGUAGE_KEYWORDS = {
	javascript: JS_KEYWORDS,
	typescript: JS_KEYWORDS,
	js: JS_KEYWORDS,
	ts: JS_KEYWORDS,
	python: PYTHON_KEYWORDS,
	py: PYTHON_KEYWORDS
}

var CodeHighlightType
;(function (CodeHighlightType) {
	CodeHighlightType[(CodeHighlightType['DEFAULT'] = 0)] = 'DEFAULT'
	CodeHighlightType[(CodeHighlightType['KEYWORD'] = 1)] = 'KEYWORD'
	CodeHighlightType[(CodeHighlightType['METHOD'] = 2)] = 'METHOD'
	CodeHighlightType[(CodeHighlightType['STRING'] = 3)] = 'STRING'
	CodeHighlightType[(CodeHighlightType['NUMBER'] = 4)] = 'NUMBER'
	CodeHighlightType[(CodeHighlightType['COMMENT'] = 5)] = 'COMMENT'
})(CodeHighlightType || (CodeHighlightType = {}))

var RichSubMessageType
;(function (RichSubMessageType) {
	RichSubMessageType[(RichSubMessageType['UNKNOWN'] = 0)] = 'UNKNOWN'
	RichSubMessageType[(RichSubMessageType['GRID_IMAGE'] = 1)] = 'GRID_IMAGE'
	RichSubMessageType[(RichSubMessageType['TEXT'] = 2)] = 'TEXT'
	RichSubMessageType[(RichSubMessageType['INLINE_IMAGE'] = 3)] = 'INLINE_IMAGE'
	RichSubMessageType[(RichSubMessageType['TABLE'] = 4)] = 'TABLE'
	RichSubMessageType[(RichSubMessageType['CODE'] = 5)] = 'CODE'
	RichSubMessageType[(RichSubMessageType['DYNAMIC'] = 6)] = 'DYNAMIC'
	RichSubMessageType[(RichSubMessageType['MAP'] = 7)] = 'MAP'
	RichSubMessageType[(RichSubMessageType['LATEX'] = 8)] = 'LATEX'
	RichSubMessageType[(RichSubMessageType['CONTENT_ITEMS'] = 9)] = 'CONTENT_ITEMS'
})(RichSubMessageType || (RichSubMessageType = {}))

const tokenizeCode = (codeStr, language = 'javascript') => {
	const keywords = LANGUAGE_KEYWORDS[language] || JS_KEYWORDS
	const blocks = []
	const lines = codeStr.split('\n')
	for (let li = 0; li < lines.length; li++) {
		const line = lines[li]
		const isLast = li === lines.length - 1
		const nl = isLast ? '' : '\n'
		if (!line.trim()) {
			blocks.push({
				highlightType: CodeHighlightType.DEFAULT,
				codeContent: line + nl
			})
			continue
		}
		if (line.trim().startsWith('//') || line.trim().startsWith('#')) {
			blocks.push({
				highlightType: CodeHighlightType.COMMENT,
				codeContent: line + nl
			})
			continue
		}
		const regex =
			/(\/\/.*$|#.*$)|(["'`](?:[^"'`\\]|\\.)*["'`])|(\b\d+(?:\.\d+)?\b)|(\b[a-zA-Z_$][\w$]*\b)|([^\s\w$"'`]+)|(\s+)/g
		let match
		const tokens = []
		while ((match = regex.exec(line)) !== null) {
			const val = match[0]
			if (match[1]) {
				tokens.push({
					highlightType: CodeHighlightType.COMMENT,
					codeContent: val
				})
			} else if (match[2]) {
				tokens.push({
					highlightType: CodeHighlightType.STRING,
					codeContent: val
				})
			} else if (match[3]) {
				tokens.push({
					highlightType: CodeHighlightType.NUMBER,
					codeContent: val
				})
			} else if (match[4]) {
				if (keywords.has(val)) {
					tokens.push({
						highlightType: CodeHighlightType.KEYWORD,
						codeContent: val
					})
				} else {
					const after = line.slice(regex.lastIndex).trimStart()
					if (after.startsWith('(')) {
						tokens.push({
							highlightType: CodeHighlightType.METHOD,
							codeContent: val
						})
					} else {
						tokens.push({
							highlightType: CodeHighlightType.DEFAULT,
							codeContent: val
						})
					}
				}
			} else {
				tokens.push({
					highlightType: CodeHighlightType.DEFAULT,
					codeContent: val
				})
			}
		}
		if (tokens.length === 0) {
			blocks.push({
				highlightType: CodeHighlightType.DEFAULT,
				codeContent: line + nl
			})
			continue
		}
		const merged = []
		for (const t of tokens) {
			const prev = merged.length > 0 ? merged[merged.length - 1] : undefined
			if (prev && prev.highlightType === t.highlightType) {
				prev.codeContent += t.codeContent
			} else {
				merged.push({ ...t })
			}
		}
		if (merged.length > 0) {
			merged[merged.length - 1].codeContent += nl
		}
		blocks.push(...merged)
	}
	return blocks
}

const buildRichContextInfo = (quoted, options) => {
	const ctxInfo = {
		forwardingScore: 1,
		isForwarded: true,
		forwardedAiBotMessageInfo: { botJid: options.botJid ? options.botJid : '867051314767696@bot' },
		forwardOrigin: 4,
		...(options.mentions ? { mentionedJid: options.mentions } : {})
	}
	if (quoted?.key) {
		ctxInfo.stanzaId = quoted.key.id
		ctxInfo.participant = quoted.key.participant || quoted.sender || quoted.key.remoteJid
		ctxInfo.quotedMessage = quoted.message
	}
	return ctxInfo
}

const buildBotForwardedMessage = (submessages, contextInfo, unifiedResponse) => {
	const richResponse = {
		messageType: 1,
		submessages,
		contextInfo
	}
	if (unifiedResponse) {
		richResponse.unifiedResponse = unifiedResponse
	}
	return {
		botForwardedMessage: {
			message: {
				richResponseMessage: richResponse
			}
		}
	}
}

const generateTableContent = (title, headers, rows, quoted, options = {}) => {
	const { footer, headerText } = options
	const tableRows = [{ items: headers, isHeading: true }, ...rows.map(row => ({ items: row.map(String) }))]
	const submessages = []
	if (headerText) {
		submessages.push({ messageType: 2, messageText: headerText })
	}
	submessages.push({
		messageType: 4,
		tableMetadata: { title, rows: tableRows }
	})
	if (footer) {
		submessages.push({ messageType: 2, messageText: footer })
	}
	const ctxInfo = buildRichContextInfo(quoted)
	return {
		message: buildBotForwardedMessage(submessages, ctxInfo),
		messageId: generateMessageIDV2()
	}
}

const generateListContent = (title, items, quoted, options = {}) => {
	const { footer, headerText } = options
	const tableRows = items.map(item => ({
		items: Array.isArray(item) ? item.map(String) : [String(item)]
	}))
	const submessages = []
	if (headerText) {
		submessages.push({ messageType: 2, messageText: headerText })
	}
	submessages.push({
		messageType: 4,
		tableMetadata: { title, rows: tableRows }
	})
	if (footer) {
		submessages.push({ messageType: 2, messageText: footer })
	}
	const ctxInfo = buildRichContextInfo(quoted)
	return {
		message: buildBotForwardedMessage(submessages, ctxInfo),
		messageId: generateMessageIDV2()
	}
}

const generateCodeBlockContent = (code, quoted, options = {}) => {
	const { title, footer, language = 'javascript' } = options
	const submessages = []
	if (title) {
		submessages.push({ messageType: 2, messageText: title })
	}
	submessages.push({
		messageType: 5,
		codeMetadata: {
			codeLanguage: language,
			codeBlocks: tokenizeCode(code, language)
		}
	})
	if (footer) {
		submessages.push({ messageType: 2, messageText: footer })
	}
	const ctxInfo = buildRichContextInfo(quoted)
	return {
		message: buildBotForwardedMessage(submessages, ctxInfo),
		messageId: generateMessageIDV2()
	}
}

const generateLatexContent = (quoted, options) => {
	const { text, expressions, headerText, footer } = options
	const submessages = []
	if (headerText) {
		submessages.push({ messageType: 2, messageText: headerText })
	}
	const latexExpressions = expressions.map(expr => {
		const entry = {
			latexExpression: expr.latexExpression,
			url: expr.url,
			width: expr.width,
			height: expr.height
		}
		if (expr.fontHeight !== undefined) entry.fontHeight = expr.fontHeight
		if (expr.imageTopPadding !== undefined) entry.imageTopPadding = expr.imageTopPadding
		if (expr.imageLeadingPadding !== undefined) entry.imageLeadingPadding = expr.imageLeadingPadding
		if (expr.imageBottomPadding !== undefined) entry.imageBottomPadding = expr.imageBottomPadding
		if (expr.imageTrailingPadding !== undefined) entry.imageTrailingPadding = expr.imageTrailingPadding
		return entry
	})
	submessages.push({
		messageType: 8,
		latexMetadata: {
			text: text || '',
			expressions: latexExpressions
		}
	})
	if (footer) {
		submessages.push({ messageType: 2, messageText: footer })
	}
	const ctxInfo = buildRichContextInfo(quoted)
	return {
		message: buildBotForwardedMessage(submessages, ctxInfo),
		messageId: generateMessageIDV2()
	}
}

const generateLatexImageContent = async (quoted, options, uploadFn, renderLatexToPng) => {
	const { text, expressions, headerText, footer } = options
	const submessages = []
	if (headerText) {
		submessages.push({ messageType: 2, messageText: headerText })
	}
	const latexExpressions = await Promise.all(
		expressions.map(async expr => {
			const { buffer, width, height } = await renderLatexToPng(expr.latexExpression)
			const uploadResult = await uploadFn(buffer, 'image')
			const imageUrl = uploadResult.url || uploadResult.directPath
			return {
				latexExpression: expr.latexExpression,
				url: imageUrl,
				width,
				height
			}
		})
	)
	submessages.push({
		messageType: 8,
		latexMetadata: {
			text: text || '',
			expressions: latexExpressions
		}
	})
	if (footer) {
		submessages.push({ messageType: 2, messageText: footer })
	}
	const ctxInfo = buildRichContextInfo(quoted)
	return {
		message: buildBotForwardedMessage(submessages, ctxInfo),
		messageId: generateMessageIDV2()
	}
}

const generateLatexInlineImageContent = async (quoted, options, uploadFn, renderLatexToPng) => {
	const { text, expressions, headerText, footer } = options
	const submessages = []
	if (headerText) {
		submessages.push({ messageType: 2, messageText: headerText })
	}
	if (text) {
		submessages.push({ messageType: 2, messageText: text })
	}
	for (const expr of expressions) {
		const { buffer, width, height } = await renderLatexToPng(expr.latexExpression)
		const uploadResult = await uploadFn(buffer, 'image')
		const imageUrl = uploadResult.url || uploadResult.directPath
		submessages.push({
			messageType: 3,
			imageMetadata: {
				imageUrl: {
					imagePreviewUrl: imageUrl,
					imageHighResUrl: imageUrl
				},
				imageText: expr.latexExpression,
				alignment: 2
			}
		})
	}
	if (footer) {
		submessages.push({ messageType: 2, messageText: footer })
	}
	const ctxInfo = buildRichContextInfo(quoted)
	return {
		message: buildBotForwardedMessage(submessages, ctxInfo),
		messageId: generateMessageIDV2()
	}
}

const captureUnifiedResponse = msg => {
	const botFwd = msg?.botForwardedMessage?.message
	if (!botFwd) return null
	const rich = botFwd.richResponseMessage
	if (!rich?.unifiedResponse?.data) return null
	return {
		unifiedResponse: { data: rich.unifiedResponse.data },
		submessages: rich.submessages || [],
		contextInfo: rich.contextInfo || {}
	}
}

const generateUnifiedResponseContent = (quoted, captured) => {
	const ctxInfo = buildRichContextInfo(quoted)
	return {
		message: buildBotForwardedMessage(captured.submessages, ctxInfo, captured.unifiedResponse),
		messageId: generateMessageIDV2()
	}
}

const generateRichMessageContent = (submessages, quoted, options) => {
	const ctxInfo = buildRichContextInfo(quoted, options)
	return {
		message: buildBotForwardedMessage(submessages, ctxInfo),
		messageId: generateMessageIDV2()
	}
}

// GenAI "unified response" rich-menu builder: header (title/disclaimer/image), body
// (buttons or carousel cards), and footer (CTA link) sections rendered client-side by
// the GenAI unified-response primitive.
const generateRichMenuContent = (content = {}, quoted, options = {}) => {
	const header = content?.header
	const body = content?.body
	const footer = content?.footer
	const sections = []
	let messageContextInfo
	const randomToolId = () => randomBytes(8).toString('hex')
	if (header) {
		const { disclaimer = false, disclaimerText = ' ', image = { inline: false }, title = '' } = header ?? {}
		if (disclaimer) {
			messageContextInfo = { botMetadata: { messageDisclaimerText: disclaimerText } }
		}
		if (title) {
			sections.push({
				__typename: 'GenAIUnifiedResponseSection',
				view_model: {
					__typename: 'GenAISingleLayoutViewModel',
					primitive: { __typename: 'FOATextPrimitive', text: '# ' + title }
				}
			})
		}
		if (image?.url) {
			if (image?.inline) {
				sections.push({
					__typename: 'GenAIUnifiedResponseSection',
					view_model: {
						__typename: 'GenAISingleLayoutViewModel',
						primitive: {
							__typename: 'GenAIMarkdownTextUXPrimitive',
							text: '{{header}}.{{/header}}',
							inline_entities: [
								{
									__typename: 'GenAITextInlineEntity',
									key: 'header',
									metadata: {
										__typename: 'GenAILatexItem',
										latex_expression: '.',
										font_height: 24,
										padding: 4,
										latex_image: {
											__typename: 'GenAIMediaItem',
											mime_type: image.mime_type || 'image/png',
											url: image.url,
											url_fallback: image.url,
											width: image.width || 500,
											height: image.height || 500,
											expiration_timestamp_ms: Date.now() + 86400000
										}
									}
								}
							]
						}
					}
				})
			} else {
				sections.push({
					__typename: 'GenAIUnifiedResponseSection',
					view_model: {
						__typename: 'GenAISingleLayoutViewModel',
						primitive: {
							__typename: 'GenAIImagePrimitive',
							preview_image: {
								__typename: 'GenAIMediaItem',
								mime_type: image.mime_type || 'image/png',
								url: image.url
							},
							full_image: { __typename: 'GenAIMediaItem', mime_type: image.mime_type || 'image/png', url: image.url }
						}
					}
				})
			}
		}
	}
	if (body) {
		const { cards = null, buttons = null, title = '', toast = '', carousel = false, row = false } = body ?? {}
		if (carousel || row) {
			if (cards?.length >= 1) {
				sections.push({
					__typename: 'GenAIUnifiedResponseSection',
					view_model: {
						primitives: cards.map(card => ({
							__typename: 'GenAI3PExtWidgetPrimitive',
							header: { __typename: 'GenAI3PExtWidgetStandardHeader', title: card?.title || '' },
							body: {
								__typename: 'GenAI3PExtCalendarEventList',
								ctas: (card?.buttons || []).map(text => ({
									label: text,
									state: 'PENDING',
									kind: 'OTHER',
									tool_call_id: randomToolId(),
									toast: { label: card?.toast || '', __typename: 'GenAI3PExtWidgetToast' },
									__typename: 'GenAI3PExtWidgetCTA'
								})),
								sections: []
							}
						})),
						__typename: carousel ? 'GenAIHScrollLayoutViewModel' : 'GenAIActionRowLayoutViewModel'
					}
				})
			}
		} else if (buttons?.length) {
			sections.push({
				__typename: 'GenAIUnifiedResponseSection',
				view_model: {
					primitive: {
						__typename: 'GenAI3PExtWidgetPrimitive',
						header: { __typename: 'GenAI3PExtWidgetStandardHeader', title: title || '' },
						body: {
							__typename: 'GenAI3PExtCalendarEventList',
							ctas: buttons.map(text => ({
								label: text,
								state: 'PENDING',
								kind: 'OTHER',
								tool_call_id: randomToolId(),
								toast: { label: toast, __typename: 'GenAI3PExtWidgetToast' },
								__typename: 'GenAI3PExtWidgetCTA'
							})),
							sections: []
						}
					},
					__typename: 'GenAISingleLayoutViewModel'
				}
			})
		}
	}
	if (footer) {
		const { text = '', url = '', image = {} } = footer ?? {}
		const img = []
		if (image?.url) {
			img.push({
				__typename: 'GenAIMarkdownTextUXPrimitive',
				text: '{{header}}.{{/header}}',
				inline_entities: [
					{
						__typename: 'GenAITextInlineEntity',
						key: 'header',
						metadata: {
							__typename: 'GenAILatexItem',
							latex_expression: '.',
							font_height: 24,
							padding: -5,
							latex_image: {
								__typename: 'GenAIMediaItem',
								mime_type: image.mime_type || 'image/png',
								url: image.url,
								url_fallback: image.url,
								width: image.width || 100,
								height: image.height || 100,
								expiration_timestamp_ms: Date.now() + 86400000
							}
						}
					}
				]
			})
		}
		sections.push({
			view_model: {
				primitives: [
					{ cta_text: text || '', cta_type: 'OPEN_URL', cta_url: url || '', __typename: 'GenAIFooterActionPrimitive' },
					...img
				],
				__typename: 'GenAIActionRowLayoutViewModel'
			}
		})
	}
	const ctxInfo = buildRichContextInfo(quoted, options)
	if (content?.contextInfo) {
		Object.assign(ctxInfo, content.contextInfo)
	}
	const unifiedResponse = { data: Buffer.from(JSON.stringify({ sections })).toString('base64') }
	return {
		message: {
			...(messageContextInfo ? { messageContextInfo } : {}),
			...buildBotForwardedMessage(undefined, ctxInfo, unifiedResponse)
		},
		messageId: generateMessageIDV2()
	}
}

// Wraps arbitrary HTML in the GenAI "FOAHtmlPrimitiveDemoDONOTUSE" unified-response
// primitive. Meta's own naming flags this as an internal/experimental surface — it
// renders, but is not a stable, documented feature.
const generateHtmlContent = (html = '', quoted, options = {}) => {
	const ctxInfo = buildRichContextInfo(quoted, options)
	const unifiedResponse = {
		data: Buffer.from(
			JSON.stringify({
				__typename: 'GenAIUnifiedResponse',
				response_id: randomUUID(),
				sections: [
					{
						__typename: 'GenAIUnifiedResponseSection',
						view_model: {
							__typename: 'GenAISingleLayoutViewModel',
							primitive: {
								__typename: 'FOAHtmlPrimitiveDemoDONOTUSE',
								trusted_sources: [],
								payload: String(html).trim()
							}
						}
					}
				]
			})
		).toString('base64')
	}
	return {
		message: buildBotForwardedMessage(undefined, ctxInfo, unifiedResponse),
		messageId: generateMessageIDV2()
	}
}

module.exports = {
	JS_KEYWORDS,
	PYTHON_KEYWORDS,
	LANGUAGE_KEYWORDS,
	CodeHighlightType,
	RichSubMessageType,
	tokenizeCode,
	buildRichContextInfo,
	buildBotForwardedMessage,
	generateTableContent,
	generateListContent,
	generateCodeBlockContent,
	generateLatexContent,
	generateLatexImageContent,
	generateLatexInlineImageContent,
	captureUnifiedResponse,
	generateUnifiedResponseContent,
	generateRichMessageContent,
	generateRichMenuContent,
	generateHtmlContent
}
