// Self-test: encrypt each message-secret enc type with an OWN random messageSecret,
// then decrypt with the REAL exported decryptors. No device needed.
// Run: node test/enc-msgsecret-selftest.js
const crypto = require('crypto')
const { hmacSign, aesEncryptGCM } = require('../src/Utils/crypto')
const B = require('../src/index.js')
const { proto } = require('../WAProto/index.js')

const toB = t => Buffer.from(t)
const NUL = Buffer.from([0])
const mkKey = (parts, secret) => {
	const sign = Buffer.concat([...parts.map(toB), Buffer.from([1])])
	const key0 = hmacSign(secret, new Uint8Array(32), 'sha256')
	return hmacSign(sign, key0, 'sha256')
}
const enc = (pt, key, aad) => {
	const iv = crypto.randomBytes(12)
	return { encPayload: aesEncryptGCM(Buffer.from(pt), key, iv, aad), encIv: iv }
}

const secret = crypto.randomBytes(32)
const id = 'ACC03E11EF1A2CF2B5E8337E12CC0B5D'
const creator = '4915678114564@s.whatsapp.net'
const modifier = '4915678114564@s.whatsapp.net'
const EMPTY = new Uint8Array(0)
let pass = 0, fail = 0
const ok = (n, c) => { console.log((c ? '✓ ' : '✗ ') + n); c ? pass++ : fail++ }

// 1 encComment — "Enc Comment", empty AAD, plaintext = Message
{
	const pt = proto.Message.encode(proto.Message.fromObject({ conversation: 'komm' })).finish()
	const k = mkKey([id, creator, modifier, 'Enc Comment'], secret)
	const r = B.decryptComment(enc(pt, k, EMPTY), { origMsgId: id, origMsgSenderJid: creator, commenterJid: modifier, msgEncKey: secret })
	ok('decryptComment', r.conversation === 'komm')
}
// 2 encReaction — "Enc Reaction", empty AAD, plaintext = ReactionMessage
{
	const pt = proto.Message.ReactionMessage.encode(proto.Message.ReactionMessage.fromObject({ text: 'X', senderTimestampMs: 123 })).finish()
	const k = mkKey([id, creator, modifier, 'Enc Reaction'], secret)
	const r = B.decryptReaction(enc(pt, k, EMPTY), { origMsgId: id, origMsgSenderJid: creator, reactorJid: modifier, msgEncKey: secret })
	ok('decryptReaction', r.text === 'X')
}
// 3 message edit — "Message Edit", empty AAD, plaintext = Message
{
	const pt = proto.Message.encode(proto.Message.fromObject({ conversation: 'edit v2' })).finish()
	const k = mkKey([id, creator, modifier, 'Message Edit'], secret)
	const r = B.decryptMessageEdit(enc(pt, k, EMPTY), { origMsgId: id, origMsgSenderJid: creator, editorJid: modifier, msgEncKey: secret })
	ok('decryptMessageEdit', r.conversation === 'edit v2')
}
// 4 poll vote — "Poll Vote", AAD = id NUL voter, plaintext = PollVoteMessage
{
	const opt = crypto.createHash('sha256').update('OptionA').digest()
	const pt = proto.Message.PollVoteMessage.encode(proto.Message.PollVoteMessage.fromObject({ selectedOptions: [opt] })).finish()
	const k = mkKey([id, creator, modifier, 'Poll Vote'], secret)
	const aad = Buffer.concat([toB(id), NUL, toB(modifier)])
	const r = B.decryptPollVote(enc(pt, k, aad), { pollCreatorJid: creator, pollMsgId: id, pollEncKey: secret, voterJid: modifier })
	ok('decryptPollVote', Buffer.from(r.selectedOptions[0]).equals(opt))
}
// 5 event response — "Event Response", AAD = id NUL responder, plaintext = EventResponseMessage
{
	const pt = proto.Message.EventResponseMessage.encode(proto.Message.EventResponseMessage.fromObject({ response: 1, timestampMs: 999 })).finish()
	const k = mkKey([id, creator, modifier, 'Event Response'], secret)
	const aad = Buffer.concat([toB(id), NUL, toB(modifier)])
	const r = B.decryptEventResponse(enc(pt, k, aad), { eventCreatorJid: creator, eventMsgId: id, eventEncKey: secret, responderJid: modifier })
	ok('decryptEventResponse', Number(r.response) === 1)
}

// 6 secretEncryptedMessage labels — "Event Edit"/"Message Edit"/"Poll Edit"/"Poll Add Option"/
//    "Message Schedule", empty AAD, plaintext = Message; all via decryptMessageEdit(label)
for (const label of ['Event Edit', 'Message Edit', 'Poll Edit', 'Poll Add Option', 'Message Schedule']) {
	const pt = proto.Message.encode(proto.Message.fromObject({ conversation: 'x:' + label })).finish()
	const k = mkKey([id, creator, modifier, label], secret)
	const r = B.decryptMessageEdit(enc(pt, k, EMPTY), { origMsgId: id, origMsgSenderJid: creator, editorJid: modifier, msgEncKey: secret, label })
	ok('secretEnc(' + label + ')', r.conversation === 'x:' + label)
}

console.log('\nresult: ' + pass + '/' + (pass + fail) + ' enc types decrypted with own messageSecret')
process.exit(fail ? 1 : 0)
