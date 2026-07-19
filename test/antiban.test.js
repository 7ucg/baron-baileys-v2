'use strict'

// Tests for antiban.js — RateLimiter, WarmUp, AntiBan, resolveConfig, PRESETS, ContentVariator.
// No real WS connection needed — all logic is pure/stateful JS.

const { EventEmitter } = require('events')
const {
	AntiBan,
	RateLimiter,
	WarmUp,
	HealthMonitor,
	ContentVariator,
	PRESETS,
	resolveConfig,
	TimelockGuard,
	PostReconnectThrottle,
	buildContentSignature,
	wrapSocket
} = require('../src/antiban')

// ── resolveConfig ─────────────────────────────────────────────────────────────

describe('resolveConfig', () => {
	test('undefined input returns moderate preset', () => {
		const cfg = resolveConfig(undefined)
		expect(cfg.maxPerMinute).toBe(PRESETS.moderate.maxPerMinute)
		expect(cfg.maxPerDay).toBe(PRESETS.moderate.maxPerDay)
	})

	test('string "conservative" returns that preset', () => {
		const cfg = resolveConfig('conservative')
		expect(cfg.maxPerMinute).toBe(PRESETS.conservative.maxPerMinute)
	})

	test('string "aggressive" returns that preset', () => {
		const cfg = resolveConfig('aggressive')
		expect(cfg.maxPerMinute).toBe(PRESETS.aggressive.maxPerMinute)
	})

	test('object without preset key uses moderate as base', () => {
		const cfg = resolveConfig({ maxPerMinute: 99 })
		expect(cfg.maxPerMinute).toBe(99)
		expect(cfg.maxPerDay).toBe(PRESETS.moderate.maxPerDay)
	})

	test('preset key in object overrides base', () => {
		const cfg = resolveConfig({ preset: 'conservative', maxPerDay: 500 })
		expect(cfg.maxPerDay).toBe(500)
		expect(cfg.maxPerMinute).toBe(PRESETS.conservative.maxPerMinute)
	})

	test('unknown preset string throws', () => {
		expect(() => resolveConfig('turbo')).toThrow(/Unknown preset/)
	})
})

// ── PRESETS ───────────────────────────────────────────────────────────────────

describe('PRESETS', () => {
	const required = [
		'maxPerMinute',
		'maxPerHour',
		'maxPerDay',
		'minDelayMs',
		'maxDelayMs',
		'newChatDelayMs',
		'warmupDays',
		'day1Limit',
		'growthFactor',
		'inactivityThresholdHours',
		'autoPauseAt'
	]

	for (const name of ['conservative', 'moderate', 'aggressive']) {
		test(`${name} has all required fields`, () => {
			for (const field of required) {
				expect(PRESETS[name]).toHaveProperty(field)
			}
		})
	}

	test('limits increase: conservative < moderate < aggressive', () => {
		expect(PRESETS.conservative.maxPerMinute).toBeLessThan(PRESETS.moderate.maxPerMinute)
		expect(PRESETS.moderate.maxPerMinute).toBeLessThan(PRESETS.aggressive.maxPerMinute)
		expect(PRESETS.conservative.maxPerDay).toBeLessThan(PRESETS.moderate.maxPerDay)
		expect(PRESETS.moderate.maxPerDay).toBeLessThan(PRESETS.aggressive.maxPerDay)
	})

	test('delays decrease: conservative > moderate > aggressive', () => {
		expect(PRESETS.conservative.minDelayMs).toBeGreaterThan(PRESETS.moderate.minDelayMs)
		expect(PRESETS.moderate.minDelayMs).toBeGreaterThan(PRESETS.aggressive.minDelayMs)
	})

	test('warmup days decrease: conservative > moderate >= aggressive', () => {
		expect(PRESETS.conservative.warmupDays).toBeGreaterThanOrEqual(PRESETS.moderate.warmupDays)
		expect(PRESETS.moderate.warmupDays).toBeGreaterThanOrEqual(PRESETS.aggressive.warmupDays)
	})

	test('inactivity threshold: moderate >= aggressive', () => {
		expect(PRESETS.moderate.inactivityThresholdHours).toBeGreaterThanOrEqual(
			PRESETS.aggressive.inactivityThresholdHours
		)
	})
})

// ── RateLimiter ───────────────────────────────────────────────────────────────

describe('RateLimiter', () => {
	test('getDelay returns a non-negative number for a fresh limiter', async () => {
		const limiter = new RateLimiter({ maxPerMinute: 20 })
		const delay = await limiter.getDelay('491@s.whatsapp.net', 'hello')
		expect(delay).toBeGreaterThanOrEqual(0)
	})

	test('blocks when per-day limit is reached', async () => {
		const limiter = new RateLimiter({ maxPerMinute: 999, maxPerHour: 999, maxPerDay: 2 })
		await limiter.getDelay('491@s.whatsapp.net', 'a')
		limiter.record('491@s.whatsapp.net', 'a')
		await limiter.getDelay('491@s.whatsapp.net', 'b')
		limiter.record('491@s.whatsapp.net', 'b')

		const delay = await limiter.getDelay('491@s.whatsapp.net', 'c')
		expect(delay).toBe(-1)
	})

	test('blocks identical messages after maxIdenticalMessages', async () => {
		const limiter = new RateLimiter({
			maxPerMinute: 999,
			maxPerHour: 999,
			maxPerDay: 999,
			maxIdenticalMessages: 2,
			identicalMessageWindowMs: 60000
		})
		const jid = '491@s.whatsapp.net'
		const text = 'same message'

		limiter.record(jid, text)
		limiter.record(jid, text)

		const delay = await limiter.getDelay(jid, text)
		expect(delay).toBe(-1)
	})

	test('known chat gets no extra newChatDelayMs', async () => {
		const limiter = new RateLimiter({
			maxPerMinute: 999,
			maxPerHour: 999,
			maxPerDay: 999,
			minDelayMs: 100,
			maxDelayMs: 200,
			newChatDelayMs: 5000
		})
		const jid = '491@s.whatsapp.net'
		limiter.record(jid, 'first') // marks jid as known
		const delay = await limiter.getDelay(jid, 'second')
		// delay should not include newChatDelayMs (5000ms) for a known chat
		expect(delay).toBeLessThan(4000)
	})

	test('getStats returns correct structure', () => {
		const limiter = new RateLimiter()
		const stats = limiter.getStats()
		expect(stats).toHaveProperty('lastMinute')
		expect(stats).toHaveProperty('lastHour')
		expect(stats).toHaveProperty('lastDay')
		expect(stats).toHaveProperty('limits')
		expect(stats.limits).toHaveProperty('perMinute')
		expect(stats.limits).toHaveProperty('perHour')
		expect(stats.limits).toHaveProperty('perDay')
	})

	test('restoreKnownChats populates knownChats', async () => {
		const limiter = new RateLimiter({
			maxPerMinute: 999,
			maxPerHour: 999,
			maxPerDay: 999,
			minDelayMs: 100,
			maxDelayMs: 200,
			newChatDelayMs: 5000
		})
		const jid = '491@s.whatsapp.net'
		limiter.restoreKnownChats([jid])
		const delay = await limiter.getDelay(jid, 'hi')
		expect(delay).toBeLessThan(4000)
	})
})

// ── WarmUp ────────────────────────────────────────────────────────────────────

describe('WarmUp', () => {
	test('fresh instance can send on day 1', () => {
		const w = new WarmUp({ warmUpDays: 5, day1Limit: 30 })
		expect(w.canSend()).toBe(true)
	})

	test('blocks after day 1 limit is reached', () => {
		const w = new WarmUp({ warmUpDays: 5, day1Limit: 3 })
		w.record()
		w.record()
		w.record()
		expect(w.canSend()).toBe(false)
	})

	test('getStatus returns correct shape', () => {
		const w = new WarmUp({ warmUpDays: 5, day1Limit: 30 })
		const s = w.getStatus()
		expect(s).toHaveProperty('phase')
		expect(s).toHaveProperty('day')
		expect(s).toHaveProperty('totalDays')
		expect(s).toHaveProperty('todayLimit')
		expect(s).toHaveProperty('todaySent')
		expect(s).toHaveProperty('progress')
	})

	test('graduates after warmUpDays elapsed', () => {
		// Simulate a startedAt 6 days ago so getCurrentDay() returns >= warmUpDays
		const pastStart = Date.now() - 6 * 24 * 60 * 60 * 1000
		const w = new WarmUp(
			{ warmUpDays: 5, day1Limit: 30 },
			{ startedAt: pastStart, lastActiveAt: Date.now(), dailyCounts: [], graduated: false }
		)
		expect(w.canSend()).toBe(true)
		const s = w.getStatus()
		expect(s.phase).toBe('graduated')
	})

	test('daily limit grows by growthFactor each day', () => {
		const w = new WarmUp({ warmUpDays: 5, day1Limit: 10, growthFactor: 2 })
		// Day 0 limit = 10 * 2^0 = 10
		// Day 1 limit = 10 * 2^1 = 20
		// Access internal via getStatus while on day 0
		expect(w.getDailyLimit()).toBe(10)
	})

	test('exportState / restore round-trips correctly', () => {
		const w = new WarmUp({ warmUpDays: 5, day1Limit: 30 })
		w.record()
		const state = w.exportState()
		const w2 = new WarmUp({ warmUpDays: 5, day1Limit: 30 }, state)
		expect(w2.getStatus().todaySent).toBe(1)
	})

	test('reset returns to fresh state', () => {
		const w = new WarmUp({ warmUpDays: 5, day1Limit: 3 })
		w.record()
		w.record()
		w.record()
		expect(w.canSend()).toBe(false)
		w.reset()
		expect(w.canSend()).toBe(true)
	})
})

// ── HealthMonitor ─────────────────────────────────────────────────────────────

describe('HealthMonitor', () => {
	test('starts at low risk', () => {
		const h = new HealthMonitor()
		expect(h.getStatus().risk).toBe('low')
	})

	test('forbidden error raises score significantly', () => {
		const h = new HealthMonitor()
		h.recordDisconnect('403')
		const s = h.getStatus()
		expect(['medium', 'high', 'critical']).toContain(s.risk)
	})

	test('isPaused returns false at low risk', () => {
		const h = new HealthMonitor({ autoPauseAt: 'critical' })
		expect(h.isPaused()).toBe(false)
	})

	test('isPaused returns true when manually paused', () => {
		const h = new HealthMonitor()
		h.setPaused(true)
		expect(h.isPaused()).toBe(true)
	})

	test('reset clears all events', () => {
		const h = new HealthMonitor()
		h.recordDisconnect('403')
		h.reset()
		expect(h.getStatus().risk).toBe('low')
		expect(h.isPaused()).toBe(false)
	})

	test('reconnect event is recorded without raising risk', () => {
		const h = new HealthMonitor()
		h.recordReconnect()
		expect(h.getStatus().risk).toBe('low')
	})
})

// ── TimelockGuard ─────────────────────────────────────────────────────────────

describe('TimelockGuard', () => {
	test('allows send by default', () => {
		const g = new TimelockGuard()
		const result = g.canSend('491@s.whatsapp.net')
		expect(result.allowed).toBe(true)
	})

	test('record463Error activates timelock', () => {
		const g = new TimelockGuard()
		g.record463Error()
		// New contact should be blocked
		const result = g.canSend('new-contact@s.whatsapp.net')
		expect(result.allowed).toBe(false)
	})

	test('known chat is exempt from timelock', () => {
		const g = new TimelockGuard()
		const jid = '491@s.whatsapp.net'
		g.registerKnownChat(jid)
		g.record463Error()
		expect(g.canSend(jid).allowed).toBe(true)
	})

	test('reset clears timelock state', () => {
		const g = new TimelockGuard()
		g.record463Error()
		g.reset()
		const result = g.canSend('new@s.whatsapp.net')
		expect(result.allowed).toBe(true)
	})
})

// ── PostReconnectThrottle ─────────────────────────────────────────────────────

describe('PostReconnectThrottle', () => {
	test('allows sends before any reconnect', () => {
		const t = new PostReconnectThrottle()
		expect(t.beforeSend().allowed).toBe(true)
	})

	test('throttles after per-window allowance is exhausted post-reconnect', () => {
		// baseline=1/min, multiplier=0.1 → allowedInWindow = max(1, floor(1*0.1)) = 1
		// First send is allowed, second is blocked (same window)
		const t = new PostReconnectThrottle({
			enabled: true,
			rampDurationMs: 60000,
			rampSteps: 6,
			initialRateMultiplier: 0.1,
			baselineRatePerMinute: () => 1
		})
		t.onReconnect()
		t.beforeSend() // uses up the 1-per-minute allowance
		const result = t.beforeSend()
		expect(result.allowed).toBe(false)
		t.destroy()
	})
})

// ── AntiBan ───────────────────────────────────────────────────────────────────

describe('AntiBan', () => {
	const instances = []
	const make = (...args) => {
		const ab = new AntiBan(...args)
		instances.push(ab)
		return ab
	}
	afterAll(() => instances.forEach(ab => ab.destroy()))

	test('constructs without throwing on preset string', () => {
		expect(() => make('moderate')).not.toThrow()
	})

	test('constructs without throwing on config object', () => {
		expect(() => make({ maxPerMinute: 10 })).not.toThrow()
	})

	test('constructs without throwing when input is undefined', () => {
		expect(() => make()).not.toThrow()
	})

	test('beforeSend returns allowed:true on fresh instance', async () => {
		const ab = make('moderate')
		const result = await ab.beforeSend('491@s.whatsapp.net', 'hello')
		expect(result.allowed).toBe(true)
		expect(result.delayMs).toBeGreaterThanOrEqual(0)
	})

	test('afterSend increments messagesAllowed', async () => {
		const ab = make('moderate')
		await ab.beforeSend('491@s.whatsapp.net', 'hi')
		ab.afterSend('491@s.whatsapp.net', 'hi')
		expect(ab.getStats().messagesAllowed).toBe(1)
	})

	test('getStats returns all expected top-level keys', async () => {
		const ab = make('moderate')
		const stats = ab.getStats()
		expect(stats).toHaveProperty('messagesAllowed')
		expect(stats).toHaveProperty('messagesBlocked')
		expect(stats).toHaveProperty('totalDelayMs')
		expect(stats).toHaveProperty('health')
		expect(stats).toHaveProperty('warmUp')
		expect(stats).toHaveProperty('rateLimiter')
	})

	test('pause blocks beforeSend', async () => {
		const ab = make('moderate')
		ab.pause()
		const result = await ab.beforeSend('491@s.whatsapp.net', 'hi')
		expect(result.allowed).toBe(false)
		expect(result.reason).toMatch(/health|risk/i)
	})

	test('resume allows after pause', async () => {
		const ab = make('moderate')
		ab.pause()
		ab.resume()
		const result = await ab.beforeSend('491@s.whatsapp.net', 'hi')
		expect(result.allowed).toBe(true)
	})

	test('destroy does not throw', () => {
		const ab = new AntiBan('moderate')
		expect(() => ab.destroy()).not.toThrow()
	})

	test('reset clears stats', async () => {
		const ab = make('moderate')
		await ab.beforeSend('491@s.whatsapp.net', 'hi')
		ab.afterSend('491@s.whatsapp.net', 'hi')
		ab.reset()
		expect(ab.getStats().messagesAllowed).toBe(0)
	})

	test('exportWarmUpState returns a plain object', () => {
		const ab = make('moderate')
		const state = ab.exportWarmUpState()
		expect(typeof state).toBe('object')
		expect(state).not.toBeNull()
	})
})

// ── ContentVariator ───────────────────────────────────────────────────────────

describe('ContentVariator', () => {
	test('vary returns a string', () => {
		const v = new ContentVariator()
		expect(typeof v.vary('hello world')).toBe('string')
	})

	test('vary does not return empty string', () => {
		const v = new ContentVariator()
		expect(v.vary('hello world').length).toBeGreaterThan(0)
	})

	test('vary changes the text over multiple calls', () => {
		const v = new ContentVariator({ zeroWidthChars: true, punctuationVariation: true })
		const results = new Set()
		for (let i = 0; i < 10; i++) results.add(v.vary('hello world from test'))
		// At least 2 different variations expected over 10 calls
		expect(results.size).toBeGreaterThan(1)
	})

	test('varyBulk returns N unique-ish strings', () => {
		const v = new ContentVariator({ zeroWidthChars: true })
		const results = v.varyBulk('send this message to many', 5)
		expect(results).toHaveLength(5)
		expect(results.every(r => typeof r === 'string' && r.length > 0)).toBe(true)
	})

	test('customVariator is called when provided', () => {
		const called = []
		const v = new ContentVariator({
			customVariator: (text, n) => {
				called.push(n)
				return text + n
			}
		})
		v.vary('test')
		expect(called.length).toBe(1)
	})

	test('emojiPadding appends emoji or empty string', () => {
		const v = new ContentVariator({ emojiPadding: true, zeroWidthChars: false, punctuationVariation: false })
		const result = v.vary('hello')
		expect(result.startsWith('hello')).toBe(true)
	})
})

// ── buildContentSignature / identical-message dedup for non-text content ─────

describe('buildContentSignature', () => {
	test('two different captionless images produce different signatures', () => {
		const sigA = buildContentSignature({ image: Buffer.from('image-bytes-one') })
		const sigB = buildContentSignature({ image: Buffer.from('image-bytes-two') })
		expect(sigA).not.toBe(sigB)
	})

	test('the same image buffer produces the same signature', () => {
		const sigA = buildContentSignature({ image: Buffer.from('identical-bytes') })
		const sigB = buildContentSignature({ image: Buffer.from('identical-bytes') })
		expect(sigA).toBe(sigB)
	})

	test('caption is folded into the signature', () => {
		const sigA = buildContentSignature({ image: Buffer.from('same'), caption: 'hello' })
		const sigB = buildContentSignature({ image: Buffer.from('same'), caption: 'world' })
		expect(sigA).not.toBe(sigB)
	})

	test('different media types never collide even with matching bytes', () => {
		const sigA = buildContentSignature({ image: Buffer.from('xyz') })
		const sigB = buildContentSignature({ video: Buffer.from('xyz') })
		expect(sigA).not.toBe(sigB)
	})

	test('url-based media is fingerprinted by url', () => {
		const sigA = buildContentSignature({ image: { url: 'https://example.com/a.jpg' } })
		const sigB = buildContentSignature({ image: { url: 'https://example.com/b.jpg' } })
		expect(sigA).not.toBe(sigB)
	})

	test('location messages are fingerprinted by coordinates', () => {
		const sigA = buildContentSignature({ location: { degreesLatitude: 1, degreesLongitude: 2 } })
		const sigB = buildContentSignature({ location: { degreesLatitude: 3, degreesLongitude: 4 } })
		expect(sigA).not.toBe(sigB)
	})

	test('empty object does not collapse to the same signature as any real content', () => {
		const sigEmpty = buildContentSignature({})
		const sigImage = buildContentSignature({ image: Buffer.from('abc') })
		expect(sigEmpty).not.toBe(sigImage)
	})
})

describe('RateLimiter identical-message dedup with dedupKey', () => {
	test('distinct captionless images are never blocked as identical', async () => {
		const limiter = new RateLimiter({
			maxPerMinute: 999,
			maxPerHour: 999,
			maxPerDay: 999,
			maxIdenticalMessages: 2,
			identicalMessageWindowMs: 60000
		})
		const jid = '491@s.whatsapp.net'
		for (let i = 0; i < 5; i++) {
			const dedupKey = buildContentSignature({ image: Buffer.from('unique-image-' + i) })
			const delay = await limiter.getDelay(jid, '', dedupKey)
			expect(delay).not.toBe(-1)
			limiter.record(jid, '', dedupKey)
		}
	})

	test('the same media sent repeatedly still trips the identical-message guard', async () => {
		const limiter = new RateLimiter({
			maxPerMinute: 999,
			maxPerHour: 999,
			maxPerDay: 999,
			maxIdenticalMessages: 2,
			identicalMessageWindowMs: 60000
		})
		const jid = '491@s.whatsapp.net'
		const dedupKey = buildContentSignature({ image: Buffer.from('same-image-every-time') })
		await limiter.getDelay(jid, '', dedupKey)
		limiter.record(jid, '', dedupKey)
		await limiter.getDelay(jid, '', dedupKey)
		limiter.record(jid, '', dedupKey)
		const delay = await limiter.getDelay(jid, '', dedupKey)
		expect(delay).toBe(-1)
	})

	test('omitting dedupKey falls back to hashing content (backward compatible)', async () => {
		const limiter = new RateLimiter({
			maxPerMinute: 999,
			maxPerHour: 999,
			maxPerDay: 999,
			maxIdenticalMessages: 2,
			identicalMessageWindowMs: 60000
		})
		const jid = '491@s.whatsapp.net'
		limiter.record(jid, 'same text')
		limiter.record(jid, 'same text')
		const delay = await limiter.getDelay(jid, 'same text')
		expect(delay).toBe(-1)
	})
})

// ── AntiBan advanced guard config (flat preset + guard blocks combined) ──────

describe('AntiBan advanced guard config', () => {
	const instances = []
	const make = (...args) => {
		const ab = new AntiBan(...args)
		instances.push(ab)
		return ab
	}
	afterAll(() => instances.forEach(ab => ab.destroy()))

	test('advanced guards are disabled by default', () => {
		const ab = make({ preset: 'aggressive' })
		expect(ab.presence['config'].enabled).toBe(false)
		expect(ab.replyRatio['config'].enabled).toBe(false)
		expect(ab.contactGraph['config'].enabled).toBe(false)
	})

	test('preset + flat override + advanced guard config combine without discarding the preset', () => {
		const ab = make({ preset: 'moderate', maxPerMinute: 20, presence: { enabled: true, enableTypingModel: true } })
		expect(ab.resolvedConfig.maxPerMinute).toBe(20)
		expect(ab.resolvedConfig.maxPerDay).toBe(PRESETS.moderate.maxPerDay)
		expect(ab.presence['config'].enabled).toBe(true)
	})

	test('replyRatio config block enables the guard', () => {
		const ab = make({ preset: 'moderate', replyRatio: { enabled: true, minRatio: 0.2 } })
		expect(ab.replyRatio['config'].enabled).toBe(true)
		expect(ab.replyRatio['config'].minRatio).toBe(0.2)
	})

	test('retryTracker config block enables the guard', () => {
		const ab = make({ preset: 'moderate', retryTracker: { enabled: true, maxRetries: 7 } })
		expect(ab.retryTracker['config'].enabled).toBe(true)
		expect(ab.retryTracker['config'].maxRetries).toBe(7)
	})

	test('legacy nested rateLimiter/warmUp still works, and explicit flat fields win', () => {
		const ab = make({ preset: 'conservative', maxPerMinute: 42, rateLimiter: { maxPerHour: 111 } })
		expect(ab.resolvedConfig.maxPerMinute).toBe(42)
		expect(ab.rateLimiter.config.maxPerHour).toBe(111)
	})
})

// ── wrapSocket teardown ───────────────────────────────────────────────────────

describe('wrapSocket', () => {
	function makeMockSock() {
		const ev = new EventEmitter()
		return {
			ev,
			sendMessage: jest.fn(async () => ({ key: { id: 'msg1' } }))
		}
	}

	test('destroy removes all event-bridge listeners', () => {
		const sock = makeMockSock()
		const wrapped = wrapSocket(sock, 'moderate')
		expect(sock.ev.listenerCount('connection.update')).toBeGreaterThan(0)
		expect(sock.ev.listenerCount('messages.update')).toBeGreaterThan(0)
		expect(sock.ev.listenerCount('messages.upsert')).toBeGreaterThan(0)
		wrapped.antiban.destroy()
		expect(sock.ev.listenerCount('connection.update')).toBe(0)
		expect(sock.ev.listenerCount('messages.update')).toBe(0)
		expect(sock.ev.listenerCount('messages.upsert')).toBe(0)
	})

	test('wrapped sendMessage calls through to the original and records the send', async () => {
		const sock = makeMockSock()
		const wrapped = wrapSocket(sock, 'moderate')
		const result = await wrapped.sendMessage('491@s.whatsapp.net', { text: 'hi' })
		expect(result.key.id).toBe('msg1')
		expect(sock.sendMessage).toHaveBeenCalled()
		wrapped.antiban.destroy()
	})
})
