# Antiban Protection

The antiban system is based on [baileys-antiban](https://github.com/kobie3717) by [@kobie3717](https://github.com/kobie3717) and has been bundled directly into baron-baileys-v2.

Every socket created with `makeWASocket()` is **automatically protected** — no extra setup required.
If you don't pass an `antiban` option at all, it runs with the **aggressive** preset (see
[Presets](#presets) below) — pass `{ antiban: { preset: 'moderate' } }` explicitly if you want
the more conservative numbers.

## How It Works

Every `sendMessage()` call goes through multiple guards in order:

- **Rate Limiting** — 25/min, 1200/h, 6000/day out of the box (aggressive defaults; use the `moderate` or `conservative` preset for lower limits)
- **Warmup** — new numbers start at 50 messages/day, scaling ~2× daily for 3 days
- **Circadian Rhythm** — slows down automatically during low-activity hours (2–6 AM)
- **Timelock** — on 463 errors, new contacts are blocked until the timelock expires
- **Human Delays** — jittered pause between messages, plus typing simulation
- **Session Health** — auto-pauses when error rate signals a ban risk
- **Identical Message Guard** — blocks the same content after repeated sends within a short window

## Basic Usage

```js
const sock = makeWASocket({ auth: state })

try {
	await sock.sendMessage(jid, { text: 'Hello' })
} catch (err) {
	if (err.message.includes('[baileys-antiban]')) {
		console.log('Blocked:', err.message)
		// wait, skip, or queue the message
	} else {
		throw err
	}
}
```

## Opt-out

```js
const sock = makeWASocket({ antiban: false, auth: state })
```

## Presets

Three built-in presets trade throughput for safety. If you don't specify `antiban` at all
(or specify it without a `preset`), **aggressive** is what actually runs. `moderate` and
`conservative` are opt-in — pass `{ antiban: { preset: 'moderate' } }` explicitly.

| Setting | conservative | moderate | **aggressive** (default when unconfigured) |
| --- | --- | --- | --- |
| Max/minute | 6 | 15 | **25** |
| Max/hour | 150 | 500 | **1200** |
| Max/day | 1000 | 3000 | **6000** |
| Min delay | 2000ms | 1000ms | **600ms** |
| Max delay | 6000ms | 4000ms | **2500ms** |
| New chat extra delay | 3000ms | 2000ms | **1500ms** |
| Warmup days | 7 | 5 | **3** |
| Day 1 limit | 20 | 30 | **50** |
| Auto-pause at | high | critical | **critical** |
| Inactivity reset | 120h | 168h | **96h** |

```js
// Explicit preset — recommended, since not specifying one runs 'aggressive'
const sock = makeWASocket({ antiban: { preset: 'moderate' }, auth: state })

// Override individual settings on top of a preset
const sock = makeWASocket({
	antiban: { preset: 'moderate', maxPerMinute: 20 },
	auth: state
})
```

## sock.antiban — Stats & Diagnostics

```js
const stats = sock.antiban.getStats()
// {
//   messagesAllowed: 312,
//   messagesBlocked: 4,
//   totalDelayMs: 487000,
//   health:      { risk: 'low', score: 0, paused: false },
//   warmUp:      { phase: 'graduated', day: 5, totalDays: 5, todayLimit: -1, todaySent: 47 },
//   rateLimiter: { lastMinute: 3, lastHour: 47, lastDay: 312, limits: { perMinute: 15, perHour: 500, perDay: 3000 } }
// }
```

### Individual Guards

```js
// Health — is antiban paused due to ban risk?
const health = sock.antiban.health.getStatus()
// { risk: 'low'|'medium'|'high'|'critical', score: 0, paused: false, recommendation: '...' }

// Warmup status
const warmup = sock.antiban.warmUp.getStatus()
// { phase: 'warming'|'graduated', day: 3, totalDays: 5, todayLimit: 97, todaySent: 12 }

// Rate limiter counts
const rate = sock.antiban.rateLimiter.getStats()
// { lastMinute: 3, lastHour: 47, lastDay: 312, limits: { perMinute: 15, ... } }

// Timelock (463 errors)
const tl = sock.antiban.timelock.getState()
// { isActive: false, errorCount: 0 }
```

### Manual Pause / Resume

```js
sock.antiban.pause() // stop all sends
sock.antiban.resume() // re-enable
```

### Cleanup on Disconnect

```js
sock.ev.on('connection.update', ({ connection }) => {
	if (connection === 'close') {
		sock.antiban.destroy() // stops all internal timers
	}
})
```

## Error Messages

| Error text            | Meaning                                  |
| --------------------- | ---------------------------------------- |
| `rate limit exceeded` | Minute/hour/day cap hit                  |
| `warm-up daily limit` | Number is in warmup, today's cap reached |
| `timelock active`     | 463 error is active, new contact blocked |
| `health risk`         | Health guard paused all sends            |

## Using AntiBan Standalone (without makeWASocket)

Import and use the guards individually or via `wrapSocket`:

```js
const { wrapSocket, AntiBan, RateLimiter, WarmUp } = require('baron-baileys-v2/src/antiban')

// Wrap an existing Baileys socket
const wrapped = wrapSocket(sock, 'moderate')
// wrapped.sendMessage is now rate-limited and guarded

// Or create AntiBan manually
const ab = new AntiBan('moderate')

const decision = await ab.beforeSend(jid, text)
if (!decision.allowed) {
	console.log('Blocked:', decision.reason)
	return
}
if (decision.delayMs > 0) await sleep(decision.delayMs)

await sock.sendMessage(jid, { text })
ab.afterSend(jid, text)
```

## Advanced Guards (opt-in)

Beyond rate-limiting, warm-up, health, and timelock — which are always active — there are
several behavioral-mimicry guards that ship **disabled by default** because they change how
your bot behaves (typing indicators, auto-replies, delayed reads) in ways not every use case
wants. Turn them on by passing their config block; each is independent, and any combination
of them can be mixed with a `preset` and flat overrides in the same object:

```js
const sock = makeWASocket({
	antiban: {
		preset: 'moderate',
		maxPerMinute: 20, // flat override, still applies
		presence: { enabled: true, enableTypingModel: true }, // now also active
		replyRatio: { enabled: true }
	},
	auth: state
})
```

These blocks are **not** deprecated — they're the normal, permanent way to configure a guard
with more fields than a flat preset override can reasonably hold (many sub-fields, or a
callback hook like `onSpiral`). Only nesting the old `rateLimiter` / `warmUp` shape is
deprecated (see below), because those two are pure duplicates of flat fields that already exist.

| Guard | Config key | Default | What it does |
| --- | --- | --- | --- |
| **Presence Choreographer** | `presence` | `enabled: false` | Typing simulation (WPM + think-pauses), circadian activity rhythm, delayed/skipped read receipts, distraction pauses, offline gaps. |
| **Reply Ratio Guard** | `replyRatio` | `enabled: false` | Cools down a contact you're messaging far more than they reply to you — a common spam signal. |
| **Contact Graph Warmer** | `contactGraph` | `enabled: false` | Requires a "handshake" delay before messaging strangers, rate-limits new-contact messages per day, and enforces a lurk period after joining a group before posting. |
| **Retry Reason Tracker** | `retryTracker` | `enabled: false` | Classifies message-retry failures (bad MAC, no session, timeout, ...) and flags messages stuck in a retry spiral. |
| **Post-Reconnect Throttle** | `reconnectThrottle` | `enabled: false` | Ramps send rate back up gradually after a reconnect instead of resuming at full speed immediately. |
| **JID Canonicalizer / LID Resolver** | `jidCanonicalizer` / `lidResolver` | `enabled: false` | Learns LID↔PN mappings from traffic and canonicalizes outbound sends, so the same contact isn't tracked as two different rate-limit identities. |
| **Session Stability Monitor** | `sessionStability` | `enabled: false` | Watches decrypt failure rate (Bad MAC) and flags session degradation before it becomes a full ban risk. |

Each block's fields are documented in its class's `DEFAULT_CONFIG` in `src/antiban.js` — pass
only the fields you want to change; everything else keeps its default.

### Migrating the old nested `rateLimiter` / `warmUp` shape

Older configs nested rate-limiter and warm-up fields:

```js
// v2-style, still works but deprecated
new AntiBan({ rateLimiter: { maxPerMinute: 8 }, warmUp: { warmUpDays: 5 } })
```

These two are pure duplicates of flat fields — `maxPerMinute` and `warmupDays` do the exact
same thing directly:

```js
new AntiBan({ maxPerMinute: 8, warmupDays: 5 })
```

If both are present, the flat top-level fields always win; the nested block only fills in
whatever the flat fields didn't cover. A deprecation notice prints once when nesting is detected.

## Identical-Message Detection Covers Media, Not Just Text

The rate limiter's identical-message spam guard used to hash only the extracted text/caption,
so every caption-less image, video, document, sticker, location, contact card, or poll
collapsed onto the same empty-string hash — a burst of *different* photos to different people
could get mistaken for spamming the same message. It now builds a signature that folds in the
message type and a cheap content fingerprint (buffer length + sampled bytes, or the media URL),
so distinct media no longer collides while true repeats are still caught.

## Persist State Across Restarts

Warmup progress and known chats survive restarts when you pass a file path:

```js
const sock = makeWASocket({
	antiban: { preset: 'moderate', persist: './antiban-state.json' },
	auth: state
})
```

The state file is written with a 5s debounce after every send, and immediately on ban/restriction events.

## Credits

Antiban logic by [@kobie3717](https://github.com/kobie3717) — [baileys-antiban](https://github.com/kobie3717/baileys-antiban)
