# baron-baileys-v2

Una librería de WhatsApp Web de alto rendimiento construida sobre [Baileys](https://github.com/WhiskeySockets/Baileys), con rutas críticas aceleradas mediante un [puente Rust WASM](https://github.com/7ucg/whatsapp-rust-bridge).

---

Consulta [CHANGELOG.md](CHANGELOG.md) para el historial completo de versiones.

---

## Índice

- [Qué hay de diferente](#qué-hay-de-diferente)
- [Instalación](#instalación)
- [Conectar Cuenta](#conectar-cuenta)
  - [Código QR](#código-qr)
  - [Código de Emparejamiento](#código-de-emparejamiento)
  - [Recibir Historial Completo](#recibir-historial-completo)
- [Notas de Configuración del Socket](#notas-de-configuración-del-socket)
- [Guardar y Restaurar Sesiones](#guardar--restaurar-sesiones)
- [Manejo de Eventos](#manejo-de-eventos)
- [Sistema Anti-Ban](#sistema-anti-ban)
  - [RateLimiter](#ratelimiter--limitar-mensajes-salientes)
  - [WarmUp](#warmup--incremento-gradual-del-límite-diario-para-números-nuevos)
  - [HealthMonitor](#healthmonitor--detectar-riesgo-de-ban)
  - [TimelockGuard](#timelockguard--manejar-bloqueos-de-contacto-wa-463)
  - [PresenceChoreographer](#presencechoreographer--simulación-de-escritura-humana)
  - [wrapSocket](#wrapsocket--aplicar-todas-las-capas-anti-ban-a-la-vez)
- [Enviar Mensajes](#enviar-mensajes)
  - [Texto y Básicos](#texto--básicos)
  - [Botones e Interactivos](#botones-e-interactivos)
  - [Media](#media)
  - [Meta AI / Respuestas Enriquecidas](#meta-ai--respuestas-enriquecidas)
  - [Estados / Stories](#estados--stories)
- [Modificar Mensajes](#modificar-mensajes)
- [Manipular Media](#manipular-media)
- [Grupos](#grupos)
- [Privacidad](#privacidad)
- [Consultas de Usuario](#consultas-de-usuario)
- [Cambiar Perfil](#cambiar-perfil)
- [Modificadores de Chat](#modificadores-de-chat)
- [MEX — GraphQL Interno de WhatsApp](#mex---graphql-interno-de-whatsapp)
- [Escribir Funcionalidades Personalizadas](#escribir-funcionalidades-personalizadas)
- [Puente Rust WASM](#puente-rust-wasm)

---

## MEX — GraphQL Interno de WhatsApp

Todas las funciones de WhatsApp (privacidad, passkeys, perfiles, nombres de usuario, comprobaciones de integridad, ...) se ejecutan sobre MEX — el protocolo GraphQL-over-WebSocket de WhatsApp. Cada método está disponible directamente en tu socket:

```js
// Privacidad
await sock.setPrivacySetting('LAST_SEEN', 'CONTACTS') // enums en MAYÚSCULAS
await sock.updateGroupsAddPrivacy('contact_blacklist') // también disponibles ayudantes IQ en minúsculas

// Integridad de contacto — verificar si un JID está en WhatsApp antes de abrir un chat
const result = await sock.contactIntegrityQuery(['491234567890@s.whatsapp.net'])

// Búsqueda de nombre de usuario
const user = await sock.findUserByUsername('baron')
// { jid: '49123456789@s.whatsapp.net', contact: false } o null

// Texto de "Info" (About)
const abouts = await sock.getTextStatusList(['491234567890@s.whatsapp.net'])

// Manejo de errores — todos los métodos MEX lanzan Boom en caso de fallo
try {
	await sock.setPrivacySetting('LAST_SEEN', 'NONE')
} catch (err) {
	// err.output.statusCode: 400 bad request, 403 not available, 404 not found
}
```

Consulta [MEX.md](documentation/MEX.md) para la documentación completa.

---

## Documentación de Funcionalidades

| Tema                                                                      | Archivo                                                   |
| -------------------------------------------------------------------------- | ------------------------------------------------------ |
| Protocolo GraphQL interno de WhatsApp (MEX)                               | [MEX.md](documentation/MEX.md)                         |
| USync — Consultas de datos de usuario masivas (dispositivos, estado, foto, LID) | [USYNC.md](documentation/USYNC.md)                     |
| HTTPS GraphQL — Meta AI, Eventos, Pagos                                  | [GRAPHQL.md](documentation/GRAPHQL.md)                 |
| Privacidad, Perfil y Cuenta                                             | [PRIVACY.md](documentation/PRIVACY.md)                 |
| Registro, Passkeys y Gestión de Cuenta                                   | [REGISTRATION.md](documentation/REGISTRATION.md)       |
| Cuentas Gestionadas, Passkey de Pagos e IPLS                               | [MANAGED-ACCOUNT.md](documentation/MANAGED-ACCOUNT.md) |
| Comunidades y Grupos de AI                                               | [COMMUNITIES.md](documentation/COMMUNITIES.md)         |
| Interoperabilidad (BirdyChat, Haiket, DMA)                               | [INTEROP.md](documentation/INTEROP.md)                 |
| Nombre de usuario (`@username`)                                         | [USERNAME.md](documentation/USERNAME.md)               |
| Sistema Anti-Ban                                                        | [ANTIBAN.md](documentation/ANTIBAN.md)                 |
| Sistema de Ban y Ejecución (internos del APK)                            | [BAN-SYSTEM.md](documentation/BAN-SYSTEM.md)           |
| Referencia del Protocolo de WA (espacios de nombres del APK)            | [PROTOCOLS.md](documentation/PROTOCOLS.md)             |
| Puerto del Protocolo WA-Web (chat-block, enlaces de llamada, ajustes de grupo, coexistencia) | [WA-WEB-PORT.md](documentation/WA-WEB-PORT.md)         |

---

## Qué hay de diferente

**Rendimiento — Rust WASM**

| Área              | Baileys Upstream | Este fork |
| ----------------- | ---------------- | --------- |
| Decodificación Binaria | JS               | Rust WASM |
| Handshake de Noise   | JS               | Rust WASM |
| AES / HMAC / HKDF | JS (`crypto`)    | Rust WASM |
| Protocolo Signal   | `libsignal-node` | Rust WASM |

**Funciones Extra**

| Función                   | Notas                                                                                                                                                                                                                                      |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Meta AI / descifrado msmsg | Descifrado completo de mensajes de AI cifrados con `messageSecret`                                                                                                                                                        |
| Manejo de mensajes Meta AI | Recibir y procesar respuestas del bot de Meta AI                                                                                                                                                                   |
| Compositor AI enriquecido | Enviar tablas, listas, bloques de código, LaTeX mediante formato de Meta AI                                                                                                                                                   |
| Botones interactivos       | Listas, respuestas, plantillas, tarjetas, lista de productos, PIX/PAY                                                                                                                                                         |
| Interop (FB/IG)           | Paridad casi total con móvil y web para JIDs multiplataforma                                                                                                                                                       |
| Medidas anti-ban         | Huella digital de conexión alineada con los clientes oficiales                                                                                                                                                     |
| Mensajes de álbum            | Enviar múltiples archivos multimedia como un álbum                                                                                                                                                                             |
| Packs de stickers             | Soporte para mensajes de packs de stickers                                                                                                                                                                                |
| Mensajes de boletín       | Mensajes de invitación para seguidores                                                                                                                                                                                    |
| Puerto protocolo WA-Web      | Toggle de chat-block, sala de espera de enlaces de llamada, ops de subgrupos de comunidad, ajustes de compartir grupo, reporte de spam, aceptación de TOS, eventos de grupo/boletín mex, eventos de cuenta sucia/sincronización de dispositivo — [WA-WEB-PORT.md](documentation/WA-WEB-PORT.md) |
| Señalización de llamadas de alto nivel | Emite `call` tanto para estrofas envueltas en `<call>` como para `<offer>`/`<terminate>` de nivel superior (+ las confirma)                                                                                                          |
| `callKey` de llamada            | `<enc>` de oferta entrante descifrado por Signal; `call.callKey` (bytes crudos de clave SRTP) poblado en el evento `call`                                                                                                  |
| Sala de espera              | `call.status = 'waiting_room_request'` + `call.peerJid` cuando un participante entra en la sala de espera de un enlace de llamada                                                                                                |
| Recv estado de boletín    | Evento `newsletter.status` para estrofas `<status>` enviadas por el servidor: texto/media/reacción/revocación, contadores de interacción, marcas de tiempo de edición                                                                                                           |
| Privacidad de audiencia de estado   | `sendMessage(jid, content, { statusPrivacy: 'contacts' \| 'allowlist' \| 'denylist' })` controla quién recibe una difusión de estado                                                                                                           |
| Telemetría WAM             | Eventos WAM `Login` y `WebcSocketConnect` disparados tras conectar; vaciado periódico cada 30s a IQ `w:stats`                                                                                                          |

---

## Instalación

```bash
npm install github:7ucg/baron-baileys-v2
# o
yarn add github:7ucg/baron-baileys-v2
```

**Requisitos:** Node.js ≥ 20

**Dependencias pares opcionales:**

| Paquete           | Propósito                       |
| ----------------- | ----------------------------- |
| `sharp`           | Procesamiento de imágenes / miniaturas |
| `jimp`            | Procesamiento de imágenes (fallback)     |
| `audio-decode`    | Metadatos de mensajes de voz        |
| `link-preview-js` | Generación de previsualización de enlaces       |

---

## Conectar Cuenta

### Código QR

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

### Código de Emparejamiento

```js
const sock = makeWASocket({ auth: state, printQRInTerminal: false })

if (!state.creds.registered) {
	const code = await sock.requestPairingCode('49123456789') // número de teléfono sin +
	console.log('Código de emparejamiento:', code)
}
```

### Recibir Historial Completo

```js
const sock = makeWASocket({
	auth: state,
	syncFullHistory: true
})
```

---

## Notas de Configuración del Socket

```js
const sock = makeWASocket({
	auth: state,

	// Cachear metadatos de grupo para reducir consultas a WA (recomendado)
	cachedGroupMetadata: async jid => groupCache.get(jid),

	// Mejorar sistema de reintentos y habilitar descifrado de votos de encuestas
	getMessage: async key => store.getMsg(key),

	// Suprimir notificaciones en el teléfono mientras esté conectado
	markOnlineOnConnect: false
})
```

---

## Guardar y Restaurar Sesiones

```js
const { useMultiFileAuthState } = require('baron-baileys-v2')

const { state, saveCreds } = await useMultiFileAuthState('./auth')
// Pasar state a makeWASocket, llamar a saveCreds en creds.update
sock.ev.on('creds.update', saveCreds)
```

---

## Manejo de Eventos

### Mensajes

```js
// Mensajes nuevos o recibidos
sock.ev.on('messages.upsert', ({ messages, type }) => {})

// Actualizaciones de estado (confirmaciones de lectura, entrega, ediciones, reacciones)
sock.ev.on('messages.update', updates => {})

// Mensaje eliminado / limpiado
sock.ev.on('messages.delete', ({ keys }) => {})

// Actualización de clave de descifrado de media
sock.ev.on('messages.media-update', updates => {})

// Reacción en un mensaje
sock.ev.on('messages.reaction', reactions => {})

// Comentario en un mensaje
sock.ev.on('message.comment', ({ message, comment }) => {})

// Mensaje puesto en cuarentena por WA
sock.ev.on('message.quarantined', ({ message }) => {})

// Encuesta — se añadió una nueva opción
sock.ev.on('poll.add-option', ({ key, senderTimestampMs }) => {})
```

### Chats y Contactos

```js
sock.ev.on('chats.upsert', chats => {})
sock.ev.on('chats.update', chats => {})
sock.ev.on('chats.delete', ids => {})
sock.ev.on('chats.lock', ({ id, locked }) => {})

sock.ev.on('contacts.upsert', contacts => {})
sock.ev.on('contacts.update', contacts => {})

// Lista de bloqueados cambiada
sock.ev.on('blocklist.update', ({ blocklist, type }) => {})
```

### Grupos

```js
sock.ev.on('groups.upsert', groups => {})
sock.ev.on('groups.update', updates => {})
sock.ev.on('group-participants.update', ({ id, participants, action }) => {})

// Alguien solicitó unirse
sock.ev.on('group.join-request', ({ id, participant, action }) => {})

// Actualización de etiqueta de miembro / mención
sock.ev.on('group.member-tag.update', ({ id, participant }) => {})
```

### Boletines (Newsletters)

```js
sock.ev.on('newsletter-settings.update', update => {})
sock.ev.on('newsletter-participants.update', update => {})
sock.ev.on('newsletter.reaction', update => {})
sock.ev.on('newsletter.view', update => {})
sock.ev.on('newsletter.live-update', update => {})
sock.ev.on('newsletter.pin', update => {})
sock.ev.on('newsletter.invite', update => {})
```

### Conexión y Autenticación

```js
sock.ev.on('connection.update', ({ connection, qr, lastDisconnect, isOnline, reachoutTimeLock }) => {})
sock.ev.on('creds.update', saveCreds)

// Alerta de seguridad (ej. dispositivo vinculado eliminado)
sock.ev.on('security.alert', data => {})

// Cambio de clave de identidad de un contacto
sock.ev.on('identity.update', ({ jid }) => {})

// Configuración del servidor recibida
sock.ev.on('server.config', config => {})
```

### Llamadas

```js
// `call` se dispara tanto para señalización envuelta en <call> como de nivel superior (<offer>/<terminate>)
sock.ev.on('call', calls => {})
sock.ev.on('call.scheduled', ({ call }) => {})
sock.ev.on('call.schedule-cancelled', ({ call }) => {})

// Enlaces de llamada — crear + alternar la sala de espera del enlace
const token = await sock.createCallLink('audio')
await sock.toggleCallLinkWaitingRoom(token, true, 'audio')

// Coexistencia WA-Web (FB/IG) y pushes de sincronización de privacidad de empresa
sock.ev.on('coexistence.update', u => {}) // { kind: 'onboarding' | 'offboarding', status?, productSurface? }
sock.ev.on('business.privacy-settings-sync', s => {})
```

### Etiquetas (Labels)

```js
sock.ev.on('labels.edit', ({ label }) => {})
sock.ev.on('labels.association', ({ association, type }) => {})
sock.ev.on('labels.reorder', ({ labelIds }) => {})
```

### Presencia y Dispositivos

```js
sock.ev.on('presence.update', ({ id, presences }) => {})
sock.ev.on('devices.update', ({ id, devices, isSelf }) => {})
```

### Bot / Meta AI

```js
sock.ev.on('bot.feedback', ({ message }) => {})
sock.ev.on('bot.stop-generation', ({ message }) => {})
sock.ev.on('bot.welcome-request', ({ message }) => {})
sock.ev.on('bot.psi-metadata', ({ message }) => {})
sock.ev.on('bot.query-fanout', ({ message }) => {})
sock.ev.on('bot.media-collection', ({ message }) => {})
sock.ev.on('bot.memu-onboarding', ({ message }) => {})
```

### Sincronización y Ajustes

```js
sock.ev.on('messaging-history.set', ({ chats, contacts, messages, isLatest }) => {})
sock.ev.on('messaging-history.status', ({ progress, hasMore }) => {})
sock.ev.on('settings.update', ({ setting, value }) => {})
sock.ev.on('lid-mapping.update', ({ lid, pn }) => {})
sock.ev.on('status.psa', ({ message }) => {})
sock.ev.on('status.mention', ({ message }) => {})
sock.ev.on('media.notify', ({ message }) => {})
sock.ev.on('reminder.update', ({ message }) => {})
sock.ev.on('payment.split', ({ message }) => {})
sock.ev.on('payment.reminder', ({ message }) => {})
sock.ev.on('cloud.thread.control', ({ message }) => {})
sock.ev.on('galaxy.flow.completed', ({ message }) => {})
```

### Descifrar Votos de Encuestas

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

## Sistema Anti-Ban

Importar desde `baron-baileys-v2/src/antiban.js`:

```js
const {
	AntiBan,
	RateLimiter,
	WarmUp,
	HealthMonitor,
	TimelockGuard,
	ReplyRatioGuard,
	ContactGraphWarmer,
	PresenceChoreographer,
	PostReconnectThrottle,
	RetryReasonTracker,
	LidResolver,
	JidCanonicalizer,
	MessageQueue,
	Scheduler,
	wrapSocket
} = require('baron-baileys-v2/src/antiban')
```

### RateLimiter — limitar mensajes salientes

```js
const limiter = new RateLimiter({
	maxPerMinute: 15,
	maxPerHour: 500,
	maxPerDay: 3000,
	minDelayMs: 1000,
	maxDelayMs: 4000,
	newChatDelayMs: 2000,
	maxIdenticalMessages: 10 // por ventana de 30 minutos
})

const delay = await limiter.getDelay(jid, text)
if (delay === -1) return // bloqueado
if (delay > 0) await sleep(delay)

await sock.sendMessage(jid, { text })
limiter.record(jid, text)
```

### WarmUp — incremento gradual del límite diario para números nuevos

```js
const warmup = new WarmUp({ warmUpDays: 5, day1Limit: 30, growthFactor: 1.8 })

if (!warmup.canSend()) return
await sock.sendMessage(jid, { text })
warmup.record()

console.log(warmup.getStatus())
// { phase: 'warming', day: 2, totalDays: 5, todayLimit: 54, todaySent: 12, progress: 40 }
```

### HealthMonitor — detectar riesgo de ban

```js
const health = new HealthMonitor({ autoPauseAt: 'critical' })

sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
	if (connection === 'close') health.recordDisconnect(lastDisconnect?.error)
	if (connection === 'open') health.recordReconnect()
})

const status = health.getStatus()
// { risk: 'low'|'medium'|'high'|'critical', score, recommendation, stats }

if (health.isPaused()) return // se pausa automáticamente al nivel de riesgo configurado
```

### TimelockGuard — manejar bloqueos de contacto WA 463

```js
const guard = new TimelockGuard()

// Alimentar con eventos de connection.update
sock.ev.on('connection.update', ({ reachoutTimeLock }) => {
	if (reachoutTimeLock) guard.onTimelockUpdate(reachoutTimeLock)
})

// Verificar antes de enviar a nuevos contactos
const { allowed, reason } = guard.canSend(jid)
if (!allowed) return console.log(reason)
```

### PresenceChoreographer — simulación de escritura humana

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

### wrapSocket — aplicar todas las capas anti-ban a la vez

```js
const { wrapSocket } = require('baron-baileys-v2/src/antiban')

// 'moderate' es el predeterminado — usar 'conservative' o 'aggressive' para ajustar
const wrappedSock = wrapSocket(sock, 'moderate')
// Todas las llamadas salientes a sendMessage ahora están automáticamente limitadas en velocidad,
// simuladas en presencia y conscientes del timelock.

// O pasar anulaciones individuales:
const wrappedSock2 = wrapSocket(sock, { preset: 'moderate', maxPerMinute: 20 })
```

---

## Enviar Mensajes

### Texto y Básicos

```js
// Texto
await sock.sendMessage(jid, { text: '¡Hola!' })

// Citar (Quote)
await sock.sendMessage(jid, { text: 'Respuesta' }, { quoted: msg })

// Mención
await sock.sendMessage(jid, { text: '@49123456789', mentions: ['49123456789@s.whatsapp.net'] })

// Reenviar
await sock.sendMessage(jid, { forward: msg })

// Ubicación
await sock.sendMessage(jid, { location: { degreesLatitude: 52.5, degreesLongitude: 13.4 } })

// Ubicación en tiempo real
await sock.sendMessage(jid, {
	liveLocation: { degreesLatitude: 52.5, degreesLongitude: 13.4 },
	accuracyInMeters: 10,
	speedInMps: 0,
	degreesClockwisefromMagneticNorth: 0,
	caption: 'En vivo',
	sequenceNumber: 1
})

// Contacto
await sock.sendMessage(jid, { contacts: { displayName: 'Nombre', contacts: [{ vcard: '...' }] } })

// Reacción
await sock.sendMessage(jid, { react: { text: '👍', key: msg.key } })

// Fijar (Pin)
await sock.sendMessage(jid, { pin: { type: 1, time: 86400, key: msg.key } })

// Encuesta
await sock.sendMessage(jid, {
	poll: { name: '¿Votas?', values: ['Sí', 'No'], selectableCount: 1 }
})

// Llamada
await sock.sendMessage(jid, { call: { callId: '...', callType: 'audio' } })
```

### Botones e Interactivos

```js
// Botones de respuesta
await sock.sendMessage(jid, {
	buttonsMessage: {
		text: 'Elige:',
		buttons: [
			{ buttonId: '1', buttonText: { displayText: 'Opción A' } },
			{ buttonId: '2', buttonText: { displayText: 'Opción B' } }
		]
	}
})

// Mensaje de lista
await sock.sendMessage(jid, {
	listMessage: {
		title: 'Menú',
		description: 'Elige uno',
		buttonText: 'Abrir',
		listType: 1,
		sections: [
			{
				title: 'Sección',
				rows: [{ title: 'Item 1', rowId: 'item1' }]
			}
		]
	}
})

// Botones de plantilla
await sock.sendMessage(jid, {
	templateMessage: {
		hydratedTemplate: {
			hydratedContentText: 'Hola',
			hydratedButtons: [
				{ quickReplyButton: { displayText: 'Sí', id: 'yes' } },
				{ urlButton: { displayText: 'Visitar', url: 'https://example.com' } }
			]
		}
	}
})

// Mensaje interactivo
await sock.sendMessage(jid, {
	interactiveMessage: {
		body: { text: 'Elige' },
		footer: { text: 'Pie de página' },
		nativeFlowMessage: {
			buttons: [{ name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: 'Sí', id: 'yes' }) }]
		}
	}
})
```

### Media

```js
// Imagen
await sock.sendMessage(jid, { image: { url: './image.jpg' }, caption: 'Pie de foto' })

// Video
await sock.sendMessage(jid, { video: { url: './video.mp4' }, caption: 'Video' })

// Audio
await sock.sendMessage(jid, { audio: { url: './audio.mp3' }, mimetype: 'audio/mp4' })

// Nota de voz (PTT)
await sock.sendMessage(jid, { audio: { url: './audio.ogg' }, mimetype: 'audio/ogg; codecs=opus', ptt: true })

// GIF
await sock.sendMessage(jid, { video: { url: './anim.mp4' }, gifPlayback: true })

// PTV (video nota)
await sock.sendMessage(jid, { video: { url: './clip.mp4' }, ptv: true })

// Ver una sola vez
await sock.sendMessage(jid, { image: { url: './secret.jpg' }, viewOnce: true })

// Álbum
await sock.sendAlbumMessage(
	jid,
	[{ image: { url: './1.jpg' } }, { image: { url: './2.jpg' } }, { video: { url: './3.mp4' } }],
	{ caption: 'Álbum' }
)
```

### Meta AI / Respuestas Enriquecidas

```js
// Enviar un mensaje a Meta AI (bot Hatch) y recibir la respuesta vía messages.upsert
const msgId = await sock.sendMetaAI('¿Cuál es la capital de Alemania?')

// Multi-turno: pasar aiConversationContext de la respuesta previa de la AI
let conversationCtx
sock.ev.on('messages.upsert', ({ messages }) => {
  for (const msg of messages) {
    if (msg.key.remoteJid !== '1807055946647697@s.whatsapp.net') continue
    const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text
    if (text) console.log('[Meta AI]', text)
    const ctx = msg.message?.messageContextInfo?.botMetadata?.aiConversationContext
    if (ctx?.length) conversationCtx = ctx
  }
})

// Seguimiento en el mismo hilo de conversación
await sock.sendMetaAI('¿Y la población?', { conversationContext: conversationCtx })

// Respuesta AI enriquecida (tabla, lista, código, LaTeX)
await sock.sendRichAIResponse(jid, {
	table: {
		headers: ['Nombre', 'Valor'],
		rows: [
			['Foo', '1'],
			['Bar', '2']
		]
	}
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

// Capturar y reenviar una respuesta unificada de Meta AI
await sock.captureAndResendUnifiedResponse(jid, metaAiMsg)
```

### Estados / Stories

```js
// Estado con menciones
await sock.sendMessage('status@broadcast', {
	text: 'Hola @49123',
	mentions: ['49123@s.whatsapp.net'],
	statusMentionedJids: ['49123@s.whatsapp.net']
})

// Interacción de sticker de estado
await sock.sendMessage('status@broadcast', {
	stickerInteraction: { sticker: { url: './sticker.webp' }, reactionKey: msg.key }
})

// Citar un estado
await sock.sendMessage(jid, { text: 'Respuesta al estado' }, { quoted: statusMsg })
```

---

## Modificar Mensajes

```js
// Eliminar para todos
await sock.sendMessage(jid, { delete: msg.key })

// Editar
await sock.sendMessage(jid, { edit: msg.key, text: 'Texto actualizado' })
```

---

## Manipular Media

```js
const { downloadMediaMessage } = require('baron-baileys-v2')

// Descargar
const buffer = await downloadMediaMessage(msg, 'buffer', {})

// Re-subir a WhatsApp
const { url } = await sock.waUploadToServer(buffer, { mimetype: 'image/jpeg' })
```

---

## Grupos

```js
// Crear
const group = await sock.groupCreate('Nombre', ['49123@s.whatsapp.net'])

// Añadir / Eliminar / Promover / Demover
await sock.groupParticipantsUpdate(jid, ['49123@s.whatsapp.net'], 'add') // add | remove | promote | demote

// Cambiar nombre
await sock.groupUpdateSubject(jid, 'Nuevo Nombre')

// Cambiar descripción
await sock.groupUpdateDescription(jid, 'Descripción')

// Cambiar ajustes
await sock.groupSettingUpdate(jid, 'announcement') // announcement | not_announcement | locked | unlocked

// Salir
await sock.groupLeave(jid)

// Enlace de invitación
const code = await sock.groupInviteCode(jid)
await sock.groupRevokeInvite(jid)
await sock.groupAcceptInvite(code)

// Metadatos (ahora también devuelve memberShareHistoryMode, memberLinkMode, limitSharing)
const meta = await sock.groupMetadata(jid)

// Solicitudes de unión
const requests = await sock.groupRequestParticipantsList(jid)
await sock.groupRequestParticipantsUpdate(jid, ['49123@s.whatsapp.net'], 'approve') // approve | reject

// Todos los grupos
const all = await sock.groupFetchAllParticipating()

// Mensajes efímeros
await sock.groupToggleEphemeral(jid, 86400) // segundos, 0 = off

// Confirmar un grupo
await sock.groupAcknowledge(jid)

// Comunidades — participantes de sub-grupo vinculados, unirse a un sub-grupo, fotos de perfil por lote
const linkedParts = await sock.groupGetLinkedParticipants(communityJid)
await sock.groupJoinLinked(communityJid, subGroupJid)
const pics = await sock.getGroupProfilePictures([jid1, jid2], 'preview')
```

---

## Privacidad

```js
// Bloquear / Desbloquear
await sock.updateBlockStatus(jid, 'block') // block | unblock

// Obtener ajustes
const privacy = await sock.fetchPrivacySettings()
// { last: 'all', online: 'all', profile: 'contacts', groupadd: 'all', calladd: 'all', ... }

// Forzar obtención fresca (ignorar cache)
const fresh = await sock.fetchPrivacySettings(true)
 
// Obtener lista de bloqueados
const list = await sock.fetchBlocklist()
 
// Actualizar ajustes individuales (basado en IQ, valores en minúsculas, funciona en todas las cuentas)
await sock.updateLastSeenPrivacy('contacts') // all | contacts | contact_blacklist | none
await sock.updateOnlinePrivacy('all')
await sock.updateProfilePicturePrivacy('contacts')
await sock.updateStatusPrivacy('contacts')
await sock.updateReadReceiptsPrivacy('all')
await sock.updateGroupsAddPrivacy('contacts')
await sock.updateCallPrivacy('all')
await sock.updateDefaultDisappearingMode(86400) // segundos, 0 = off

// Establecer vía MEX GraphQL (se requieren valores en MAYÚSCULAS)
await sock.setPrivacySetting('LAST_SEEN', 'CONTACTS')
await sock.setPrivacySetting('GROUPS', 'CONTACT_BLACKLIST')
await sock.setPrivacySetting('CALLS', 'NONE')
 
// Gestionar listas de contactos para ajustes CONTACT_BLACKLIST / CONTACTS
await sock.updatePrivacyContactList('groupadd', 'contact_blacklist', [jid1, jid2])
const current = await sock.getPrivacyContactList('groupadd', 'contact_blacklist')
 
// Toggle "Bloquear mensajes de cuentas desconocidas" (WA Web w:comms:chat)
const blockStatus = await sock.getChatBlockingStatus() // 'blocked' | 'unblocked'
await sock.updateChatBlockingStatus('block') // block | unblock
 
// Divulgaciones de TOS pendientes · lista de exclusión de funciones · config de push
const notices = await sock.getUserDisclosures()
const optOut = await sock.getOptOutList()
const push = await sock.getPushConfig()
```

Consulta [MEX.md](documentation/MEX.md) para el uso completo de MEX y manejo de errores.

---

## Consultas de Usuario

```js
// Verificar si el número existe en WA
const results = await sock.onWhatsApp('49123456789')
// results[0] === { jid: '49123456789@s.whatsapp.net', exists: true }
 
// Foto de perfil
const ppUrl = await sock.profilePictureUrl(jid, 'image')
 
// Texto de estado (legacy)
const status = await sock.fetchStatus(jid)
 
// Texto de "Info" (MEX)
const abouts = await sock.getTextStatusList([jid])
// [{ jid, text: '¡Hola!', emoji: '👋', timestamp: 1234567890 }]
 
// Perfil de empresa
const biz = await sock.getBusinessProfile(jid)
 
// Presencia (escribiendo/en línea)
await sock.subscribePresence(jid)
sock.ev.on('presence.update', ({ id, presences }) => {})
 
// Historial de chat
await sock.fetchMessageHistory(50, oldestMsg.key, oldestMsg.messageTimestamp)
 
// Buscar usuario por @username
const user = await sock.findUserByUsername('algunusuario')
// { jid: '49123456789@s.whatsapp.net', contact: false } o null
 
// Verificar un JID antes de abrir un chat
const integrity = await sock.contactIntegrityQuery([jid])
```

---

## Cambiar Perfil

```js
// Estado (Info)
await sock.updateProfileStatus('Mi estado')
 
// Nombre
await sock.updateProfileName('Nuevo Nombre')
 
// Foto
await sock.updateProfilePicture(jid, { url: './photo.jpg' })
 
// Eliminar foto
await sock.removeProfilePicture(jid)
```

---

## Modificadores de Chat

```js
// Archivar
await sock.chatModify({ archive: true, lastMessages: [msg] }, jid)
 
// Silenciar (timestamp ms)
await sock.chatModify({ mute: Date.now() + 8 * 60 * 60 * 1000 }, jid)
 
// Marcar leído/no leído
await sock.chatModify({ markRead: false, lastMessages: [msg] }, jid)
 
// Eliminar mensaje para mí
await sock.chatModify({ clear: { messages: [{ id: msg.key.id, fromMe: msg.key.fromMe }] } }, jid)
 
// Eliminar chat
await sock.chatModify({ delete: true, lastMessages: [msg] }, jid)
 
// Destacar / Quitar destaque (Star / Unstar)
await sock.chatModify({ star: { messages: [{ id: msg.key.id, fromMe: msg.key.fromMe }], star: true } }, jid)
 
// Mensajes efímeros
await sock.sendMessage(jid, { disappearingMessagesInChat: 86400 })
```

---

## Escribir Funcionalidades Personalizadas

```js
// Habilitar logs de depuración
const sock = makeWASocket({ logger: pino({ level: 'debug' }) })
 
// Eventos raw de websocket
sock.ws.on('CB:message', node => console.log(node))
 
// Registrar callback para nodos específicos de WA
sock.ws.on('CB:iq,,result', node => {})
```

---

## Puente Rust WASM

El módulo nativo se encuentra en [7ucg/whatsapp-rust-bridge](https://github.com/7ucg/whatsapp-rust-bridge).  
Pre-construido y empaquetado — **no necesitas la cadena de herramientas de Rust** para usar este paquete.

Funciones delegadas a Rust:

| Función                          | Descripción                                      |
| --------------------------------- | ------------------------------------------------ |
| `decodeNode`                      | Decodificación del protocolo WABinary               |
| `NoiseSession`                    | Handshake Noise_XX_25519_AESGCM_SHA256 + framing |
| `hkdf`                            | Derivación de claves HKDF                              |
| `hmacSign`                        | Firma HMAC-SHA256                              |
| `sha256`                          | Hashing SHA-256                                  |
| `aesEncrypt` / `aesDecrypt`       | AES-256-CBC                                      |
| `aesEncryptGCM` / `aesDecryptGCM` | AES-256-GCM                                      |
| `aesEncryptCTR` / `aesDecryptCTR` | AES-256-CTR                                      |

---

## Licencia

MIT
