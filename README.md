# baron-baileys-v2

A high-performance WhatsApp Web library built on [Baileys](https://github.com/WhiskeySockets/Baileys), with critical paths accelerated via a [Rust WASM bridge](https://github.com/7ucg/whatsapp-rust-bridge).

---

## Index

- [What's Different](#whats-different)
- [Installation](#installation)
- [Connecting Account](#connecting-account)
  - [QR Code](#qr-code)
  - [Pairing Code](#pairing-code)
  - [Receive Full History](#receive-full-history)
- [Socket Config Notes](#socket-config-notes)
- [Saving & Restoring Sessions](#saving--restoring-sessions)
- [Handling Events](#handling-events)
- [Anti-Ban System](#anti-ban-system)
  - [RateLimiter](#ratelimiter--throttle-outbound-messages)
  - [WarmUp](#warmup--gradual-daily-limit-increase-for-new-numbers)
  - [HealthMonitor](#healthmonitor--detect-ban-risk)
  - [TimelockGuard](#timelockguard--handle-wa-463-reachout-blocks)
  - [PresenceChoreographer](#presencechoreographer--human-like-typing-simulation)
  - [wrapSocket](#wrapsocket--apply-all-anti-ban-layers-at-once)
- [Sending Messages](#sending-messages)
  - [Text & Basic](#text--basic)
  - [Buttons & Interactive](#buttons--interactive)
  - [Media](#media)
  - [Meta AI / Rich Responses](#meta-ai--rich-responses)
  - [Status / Stories](#status--stories)
- [Modifying Messages](#modifying-messages)
- [Manipulating Media](#manipulating-media)
- [Groups](#groups)
- [Privacy](#privacy)
- [User Queries](#user-queries)
- [Change Profile](#change-profile)
- [Chat Modifiers](#chat-modifiers)
- [Writing Custom Functionality](#writing-custom-functionality)
- [Rust WASM Bridge](#rust-wasm-bridge)

---

## What's Different

**Performance — Rust WASM**

| Area | Upstream Baileys | This fork |
|---|---|---|
| Binary decode | JS | Rust WASM |
| Noise handshake | JS | Rust WASM |
| AES / HMAC / HKDF | JS (`crypto`) | Rust WASM |
| Signal protocol | `libsignal-node` | Rust WASM |

**Extra Features**

| Feature | Notes |
|---|---|
| Meta AI / msmsg decrypt | Full `messageSecret`-encrypted AI message decryption |
| Meta AI message handling | Receive and process Meta AI bot responses |
| Rich AI composer | Send tables, lists, code blocks, LaTeX via Meta AI format |
| Interactive buttons | List, reply, template, cards, product list, PIX/PAY |
| Interop (FB/IG) | Near-parity with mobile & web for cross-platform JIDs |
| Anti-ban measures | Connection fingerprinting aligned with official clients |
| Album messages | Send multiple media as an album |
| Sticker packs | Sticker pack message support |
| Newsletter messages | Follower invite messages |

---

## Installation

```bash
npm install github:7ucg/baron-baileys-v2
# or
yarn add github:7ucg/baron-baileys-v2
```

**Requirements:** Node.js ≥ 20

**Optional peer dependencies:**

| Package | Purpose |
|---|---|
| `sharp` | Image processing / thumbnails |
| `jimp` | Fallback image processing |
| `audio-decode` | Voice message metadata |
| `link-preview-js` | Link preview generation |

---

## Connecting Account

### QR Code

```js
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('baron-baileys-v2')
const { Boom } = require('@hapi/boom')

const { state, saveCreds } = await useMultiFileAuthState('./auth')

const sock = makeWASocket({ auth: state, printQRInTerminal: true })

sock.ev.on('creds.update', saveCreds)
sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'close') {
        const shouldReconnect = new Boom(lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut
        if (shouldReconnect) connect()
    }
})
```

### Pairing Code

```js
const sock = makeWASocket({ auth: state, printQRInTerminal: false })

if (!state.creds.registered) {
    const code = await sock.requestPairingCode('49123456789') // phone number without +
    console.log('Pairing code:', code)
}
```

### Receive Full History

```js
const sock = makeWASocket({
    auth: state,
    syncFullHistory: true
})
```

---

## Socket Config Notes

```js
const sock = makeWASocket({
    auth: state,

    // Cache group metadata to reduce WA queries (recommended)
    cachedGroupMetadata: async (jid) => groupCache.get(jid),

    // Improve retry system and enable poll vote decryption
    getMessage: async (key) => store.getMsg(key),

    // Suppress notifications on the phone while connected
    markOnlineOnConnect: false,
})
```

---

## Saving & Restoring Sessions

```js
const { useMultiFileAuthState } = require('baron-baileys-v2')

const { state, saveCreds } = await useMultiFileAuthState('./auth')
// Pass state to makeWASocket, call saveCreds on creds.update
sock.ev.on('creds.update', saveCreds)
```

---

## Handling Events

### Messages

```js
// New or received messages
sock.ev.on('messages.upsert', ({ messages, type }) => { })

// Status updates (read receipts, delivery, edits, reactions)
sock.ev.on('messages.update', updates => { })

// Message deleted / cleared
sock.ev.on('messages.delete', ({ keys }) => { })

// Media decryption key update
sock.ev.on('messages.media-update', updates => { })

// Reaction on a message
sock.ev.on('messages.reaction', reactions => { })

// Comment on a message
sock.ev.on('message.comment', ({ message, comment }) => { })

// Message quarantined by WA
sock.ev.on('message.quarantined', ({ message }) => { })

// Poll — new option added
sock.ev.on('poll.add-option', ({ key, senderTimestampMs }) => { })
```

### Chats & Contacts

```js
sock.ev.on('chats.upsert', chats => { })
sock.ev.on('chats.update', chats => { })
sock.ev.on('chats.delete', ids => { })
sock.ev.on('chats.lock', ({ id, locked }) => { })

sock.ev.on('contacts.upsert', contacts => { })
sock.ev.on('contacts.update', contacts => { })

// Blocklist changed
sock.ev.on('blocklist.update', ({ blocklist, type }) => { })
```

### Groups

```js
sock.ev.on('groups.upsert', groups => { })
sock.ev.on('groups.update', updates => { })
sock.ev.on('group-participants.update', ({ id, participants, action }) => { })

// Someone requested to join
sock.ev.on('group.join-request', ({ id, participant, action }) => { })

// Member tag / mention update
sock.ev.on('group.member-tag.update', ({ id, participant }) => { })
```

### Newsletters

```js
sock.ev.on('newsletter-settings.update', update => { })
sock.ev.on('newsletter-participants.update', update => { })
sock.ev.on('newsletter.reaction', update => { })
sock.ev.on('newsletter.view', update => { })
sock.ev.on('newsletter.live-update', update => { })
sock.ev.on('newsletter.pin', update => { })
sock.ev.on('newsletter.invite', update => { })
```

### Connection & Auth

```js
sock.ev.on('connection.update', ({ connection, qr, lastDisconnect, isOnline, reachoutTimeLock }) => { })
sock.ev.on('creds.update', saveCreds)

// Security alert (e.g. linked device removed)
sock.ev.on('security.alert', data => { })

// Identity key change for a contact
sock.ev.on('identity.update', ({ jid }) => { })

// Server config received
sock.ev.on('server.config', config => { })
```

### Calls

```js
sock.ev.on('call', calls => { })
sock.ev.on('call.scheduled', ({ call }) => { })
sock.ev.on('call.schedule-cancelled', ({ call }) => { })
```

### Labels

```js
sock.ev.on('labels.edit', ({ label }) => { })
sock.ev.on('labels.association', ({ association, type }) => { })
sock.ev.on('labels.reorder', ({ labelIds }) => { })
```

### Presence & Devices

```js
sock.ev.on('presence.update', ({ id, presences }) => { })
sock.ev.on('devices.update', ({ id, devices, isSelf }) => { })
```

### Bot / Meta AI

```js
sock.ev.on('bot.feedback', ({ message }) => { })
sock.ev.on('bot.stop-generation', ({ message }) => { })
sock.ev.on('bot.welcome-request', ({ message }) => { })
sock.ev.on('bot.psi-metadata', ({ message }) => { })
sock.ev.on('bot.query-fanout', ({ message }) => { })
sock.ev.on('bot.media-collection', ({ message }) => { })
sock.ev.on('bot.memu-onboarding', ({ message }) => { })
```

### Sync & Settings

```js
sock.ev.on('messaging-history.set', ({ chats, contacts, messages, isLatest }) => { })
sock.ev.on('messaging-history.status', ({ progress, hasMore }) => { })
sock.ev.on('settings.update', ({ setting, value }) => { })
sock.ev.on('lid-mapping.update', ({ lid, pn }) => { })
sock.ev.on('status.psa', ({ message }) => { })
sock.ev.on('status.mention', ({ message }) => { })
sock.ev.on('media.notify', ({ message }) => { })
sock.ev.on('reminder.update', ({ message }) => { })
sock.ev.on('payment.split', ({ message }) => { })
sock.ev.on('payment.reminder', ({ message }) => { })
sock.ev.on('cloud.thread.control', ({ message }) => { })
sock.ev.on('galaxy.flow.completed', ({ message }) => { })
```

### Decrypt Poll Votes

```js
const { getAggregateVotesInPollMessage } = require('baron-baileys-v2')

sock.ev.on('messages.update', async updates => {
    for (const { key, update } of updates) {
        if (update.pollUpdates) {
            const pollCreation = await getMessage(key)
            if (pollCreation) {
                const votes = getAggregateVotesInPollMessage({ message: pollCreation, pollUpdates: update.pollUpdates })
                console.log(votes)
            }
        }
    }
})
```

---

## Anti-Ban System

Import from `baron-baileys-v2/src/antiban.js`:

```js
const {
    AntiBan, RateLimiter, WarmUp, HealthMonitor,
    TimelockGuard, ReplyRatioGuard, ContactGraphWarmer,
    PresenceChoreographer, PostReconnectThrottle,
    RetryReasonTracker, LidResolver, JidCanonicalizer,
    MessageQueue, Scheduler, wrapSocket
} = require('baron-baileys-v2/src/antiban')
```

### RateLimiter — throttle outbound messages

```js
const limiter = new RateLimiter({
    maxPerMinute: 8,
    maxPerHour: 200,
    maxPerDay: 1500,
    minDelayMs: 1500,
    maxDelayMs: 5000,
    newChatDelayMs: 3000
})

const delay = await limiter.getDelay(jid, text)
if (delay === -1) return // blocked
if (delay > 0) await sleep(delay)

await sock.sendMessage(jid, { text })
limiter.record(jid, text)
```

### WarmUp — gradual daily limit increase for new numbers

```js
const warmup = new WarmUp({ warmUpDays: 7, day1Limit: 20, growthFactor: 1.8 })

if (!warmup.canSend()) return
await sock.sendMessage(jid, { text })
warmup.record()

console.log(warmup.getStatus())
// { phase: 'warming', day: 2, todayLimit: 36, todaySent: 12, progress: 28 }
```

### HealthMonitor — detect ban risk

```js
const health = new HealthMonitor({ autoPauseAt: 'high' })

sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'close') health.recordDisconnect(lastDisconnect?.error)
    if (connection === 'open') health.recordReconnect()
})

const status = health.getStatus()
// { risk: 'low'|'medium'|'high'|'critical', score, recommendation, stats }

if (health.isPaused()) return // auto-pauses at configured risk level
```

### TimelockGuard — handle WA 463 reachout blocks

```js
const guard = new TimelockGuard()

// Feed connection.update events
sock.ev.on('connection.update', ({ reachoutTimeLock }) => {
    if (reachoutTimeLock) guard.onTimelockUpdate(reachoutTimeLock)
})

// Check before sending to new contacts
const { allowed, reason } = guard.canSend(jid)
if (!allowed) return console.log(reason)
```

### PresenceChoreographer — human-like typing simulation

```js
const choreo = new PresenceChoreographer({
    enabled: true,
    typingWPM: 45,
    enableCircadianRhythm: true,
    timezone: 'Europe/Berlin'
})

const plan = choreo.computeTypingPlan(text.length)
await choreo.executeTypingPlan(sock, jid, plan)
await sock.sendMessage(jid, { text })
```

### wrapSocket — apply all anti-ban layers at once

```js
const { wrapSocket, resolveConfig, PRESETS } = require('baron-baileys-v2/src/antiban')

const wrappedSock = wrapSocket(sock, resolveConfig(PRESETS.SAFE))
// All outbound sendMessage calls are now automatically rate-limited,
// presence-simulated, and timelock-aware.
```

---

## Sending Messages

### Text & Basic

```js
// Text
await sock.sendMessage(jid, { text: 'Hello!' })

// Quote
await sock.sendMessage(jid, { text: 'Reply' }, { quoted: msg })

// Mention
await sock.sendMessage(jid, { text: '@49123456789', mentions: ['49123456789@s.whatsapp.net'] })

// Forward
await sock.sendMessage(jid, { forward: msg })

// Location
await sock.sendMessage(jid, { location: { degreesLatitude: 52.5, degreesLongitude: 13.4 } })

// Live Location
await sock.sendMessage(jid, {
    liveLocation: { degreesLatitude: 52.5, degreesLongitude: 13.4 },
    accuracyInMeters: 10,
    speedInMps: 0,
    degreesClockwisefromMagneticNorth: 0,
    caption: 'Live',
    sequenceNumber: 1
})

// Contact
await sock.sendMessage(jid, { contacts: { displayName: 'Name', contacts: [{ vcard: '...' }] } })

// Reaction
await sock.sendMessage(jid, { react: { text: '👍', key: msg.key } })

// Pin
await sock.sendMessage(jid, { pin: { type: 1, time: 86400, key: msg.key } })

// Poll
await sock.sendMessage(jid, {
    poll: { name: 'Vote?', values: ['Yes', 'No'], selectableCount: 1 }
})

// Call
await sock.sendMessage(jid, { call: { callId: '...', callType: 'audio' } })
```

### Buttons & Interactive

```js
// Reply buttons
await sock.sendMessage(jid, {
    buttonsMessage: {
        text: 'Choose:',
        buttons: [
            { buttonId: '1', buttonText: { displayText: 'Option A' } },
            { buttonId: '2', buttonText: { displayText: 'Option B' } }
        ]
    }
})

// List message
await sock.sendMessage(jid, {
    listMessage: {
        title: 'Menu',
        description: 'Pick one',
        buttonText: 'Open',
        listType: 1,
        sections: [{
            title: 'Section',
            rows: [{ title: 'Item 1', rowId: 'item1' }]
        }]
    }
})

// Template buttons
await sock.sendMessage(jid, {
    templateMessage: {
        hydratedTemplate: {
            hydratedContentText: 'Hello',
            hydratedButtons: [
                { quickReplyButton: { displayText: 'Yes', id: 'yes' } },
                { urlButton: { displayText: 'Visit', url: 'https://example.com' } }
            ]
        }
    }
})

// Interactive message
await sock.sendMessage(jid, {
    interactiveMessage: {
        body: { text: 'Choose' },
        footer: { text: 'Footer' },
        nativeFlowMessage: {
            buttons: [{ name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: 'Yes', id: 'yes' }) }]
        }
    }
})
```

### Media

```js
// Image
await sock.sendMessage(jid, { image: { url: './image.jpg' }, caption: 'Caption' })

// Video
await sock.sendMessage(jid, { video: { url: './video.mp4' }, caption: 'Video' })

// Audio
await sock.sendMessage(jid, { audio: { url: './audio.mp3' }, mimetype: 'audio/mp4' })

// Voice note (PTT)
await sock.sendMessage(jid, { audio: { url: './audio.ogg' }, mimetype: 'audio/ogg; codecs=opus', ptt: true })

// GIF
await sock.sendMessage(jid, { video: { url: './anim.mp4' }, gifPlayback: true })

// PTV (video note)
await sock.sendMessage(jid, { video: { url: './clip.mp4' }, ptv: true })

// View once
await sock.sendMessage(jid, { image: { url: './secret.jpg' }, viewOnce: true })

// Album
await sock.sendAlbumMessage(jid, [
    { image: { url: './1.jpg' } },
    { image: { url: './2.jpg' } },
    { video: { url: './3.mp4' } }
], { caption: 'Album' })
```

### Meta AI / Rich Responses

```js
// Rich AI response (table, list, code, LaTeX)
await sock.sendRichAIResponse(jid, {
    table: { headers: ['Name', 'Value'], rows: [['Foo', '1'], ['Bar', '2']] }
})

await sock.sendRichAIResponse(jid, {
    list: { items: ['Item 1', 'Item 2', 'Item 3'] }
})

await sock.sendRichAIResponse(jid, {
    codeBlock: { language: 'js', code: 'console.log("hello")' }
})

await sock.sendRichAIResponse(jid, {
    latex: 'E = mc^2'
})

// Capture & resend a Meta AI unified response
await sock.captureAndResendUnifiedResponse(jid, metaAiMsg)
```

### Status / Stories

```js
// Status with mentions
await sock.sendMessage('status@broadcast', {
    text: 'Hello @49123',
    mentions: ['49123@s.whatsapp.net'],
    statusMentionedJids: ['49123@s.whatsapp.net']
})

// Status sticker interaction
await sock.sendMessage('status@broadcast', {
    stickerInteraction: { sticker: { url: './sticker.webp' }, reactionKey: msg.key }
})

// Quote a status
await sock.sendMessage(jid, { text: 'Reply to status' }, { quoted: statusMsg })
```

---

## Modifying Messages

```js
// Delete for everyone
await sock.sendMessage(jid, { delete: msg.key })

// Edit
await sock.sendMessage(jid, { edit: msg.key, text: 'Updated text' })
```

---

## Manipulating Media

```js
const { downloadMediaMessage } = require('baron-baileys-v2')

// Download
const buffer = await downloadMediaMessage(msg, 'buffer', {})

// Re-upload to WhatsApp
const { url } = await sock.waUploadToServer(buffer, { mimetype: 'image/jpeg' })
```

---

## Groups

```js
// Create
const group = await sock.groupCreate('Name', ['49123@s.whatsapp.net'])

// Add / Remove / Promote / Demote
await sock.groupParticipantsUpdate(jid, ['49123@s.whatsapp.net'], 'add')    // add | remove | promote | demote

// Change name
await sock.groupUpdateSubject(jid, 'New Name')

// Change description
await sock.groupUpdateDescription(jid, 'Description')

// Change settings
await sock.groupSettingUpdate(jid, 'announcement')  // announcement | not_announcement | locked | unlocked

// Leave
await sock.groupLeave(jid)

// Invite link
const code = await sock.groupInviteCode(jid)
await sock.groupRevokeInvite(jid)
await sock.groupAcceptInvite(code)

// Metadata
const meta = await sock.groupMetadata(jid)

// Join requests
const requests = await sock.groupRequestParticipantsList(jid)
await sock.groupRequestParticipantsUpdate(jid, ['49123@s.whatsapp.net'], 'approve')  // approve | reject

// All groups
const all = await sock.groupFetchAllParticipating()

// Ephemeral
await sock.groupToggleEphemeral(jid, 86400)  // seconds, 0 = off
```

---

## Privacy

```js
// Block / Unblock
await sock.updateBlockStatus(jid, 'block')  // block | unblock

// Get settings
const privacy = await sock.fetchPrivacySettings()

// Get blocklist
const list = await sock.fetchBlocklist()

// Update individual settings
await sock.updateLastSeenPrivacy('contacts')           // all | contacts | contact_blacklist | none
await sock.updateOnlinePrivacy('all')
await sock.updateProfilePicturePrivacy('contacts')
await sock.updateStatusPrivacy('contacts')
await sock.updateReadReceiptsPrivacy('all')
await sock.updateGroupsAddPrivacy('contacts')
await sock.updateDefaultDisappearingMode(86400)
```

---

## User Queries

```js
// Check if number exists on WA
const [result] = await sock.onWhatsApp('49123456789')
console.log(result.exists, result.jid)

// Profile picture
const ppUrl = await sock.profilePictureUrl(jid, 'image')

// Status text
const status = await sock.fetchStatus(jid)

// Business profile
const biz = await sock.getBusinessProfile(jid)

// Presence (typing/online)
await sock.subscribePresence(jid)
sock.ev.on('presence.update', ({ id, presences }) => { })

// Chat history
await sock.fetchMessageHistory(50, oldestMsg.key, oldestMsg.messageTimestamp)
```

---

## Change Profile

```js
// Status
await sock.updateProfileStatus('My status')

// Name
await sock.updateProfileName('New Name')

// Picture
await sock.updateProfilePicture(jid, { url: './photo.jpg' })

// Remove picture
await sock.removeProfilePicture(jid)
```

---

## Chat Modifiers

```js
// Archive
await sock.chatModify({ archive: true, lastMessages: [msg] }, jid)

// Mute (ms timestamp)
await sock.chatModify({ mute: Date.now() + 8 * 60 * 60 * 1000 }, jid)

// Mark read/unread
await sock.chatModify({ markRead: false, lastMessages: [msg] }, jid)

// Delete message for me
await sock.chatModify({ clear: { messages: [{ id: msg.key.id, fromMe: msg.key.fromMe }] } }, jid)

// Delete chat
await sock.chatModify({ delete: true, lastMessages: [msg] }, jid)

// Star / Unstar
await sock.chatModify({ star: { messages: [{ id: msg.key.id, fromMe: msg.key.fromMe }], star: true } }, jid)

// Disappearing messages
await sock.sendMessage(jid, { disappearingMessagesInChat: 86400 })
```

---

## Writing Custom Functionality

```js
// Enable debug logs
const sock = makeWASocket({ logger: pino({ level: 'debug' }) })

// Raw websocket events
sock.ws.on('CB:message', node => console.log(node))

// Register callback for specific WA nodes
sock.ws.on('CB:iq,,result', node => { })
```

---

## Rust WASM Bridge

The native module lives at [7ucg/whatsapp-rust-bridge](https://github.com/7ucg/whatsapp-rust-bridge).  
Pre-built and bundled — **no Rust toolchain needed** to use this package.

Functions offloaded to Rust:

| Function | Description |
|---|---|
| `decodeNode` | WABinary protocol decoding |
| `NoiseSession` | Noise_XX_25519_AESGCM_SHA256 handshake + framing |
| `hkdf` | HKDF key derivation |
| `hmacSign` | HMAC-SHA256 signing |
| `sha256` | SHA-256 hashing |
| `aesEncrypt` / `aesDecrypt` | AES-256-CBC |
| `aesEncryptGCM` / `aesDecryptGCM` | AES-256-GCM |
| `aesEncryptCTR` / `aesDecryptCTR` | AES-256-CTR |

---

## License

MIT
