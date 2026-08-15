const path = require('path')
const fs = require('fs')
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys')
const pino = require('pino')
const config = require('./config')
const db = require('./db')

const STATUS_JID = 'status@broadcast'
const sessions = new Map()
let latestVersionPromise = null
let notifyFn = null
const runtime = {
  startedAt: new Date().toISOString(),
}

function setNotifier(fn) {
  notifyFn = fn
}

async function notify(chatId, text) {
  if (!notifyFn || !chatId) return
  try {
    await notifyFn(chatId, text)
  } catch (e) {
    console.error('[notify]', e.message)
  }
}

function sessionKey(userId, number) {
  return `${userId}:${String(number || '').replace(/\D/g, '')}`
}

function authFolderFor(number) {
  return path.join(config.SESSIONS_DIR, String(number || '').replace(/\D/g, ''))
}

function randDelayMs() {
  const min = Math.max(300, Number(config.REACT_DELAY_MIN) || 1000)
  const max = Math.max(min, Number(config.REACT_DELAY_MAX) || 4000)
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function getLatestVersion() {
  if (!latestVersionPromise) {
    latestVersionPromise = fetchLatestBaileysVersion()
      .then((result) => result?.version)
      .catch((e) => {
        console.error('[baileys version]', e.message)
        return undefined
      })
  }
  return latestVersionPromise
}

function getBrowserProfile() {
  try {
    if (Browsers?.windows) return Browsers.windows('Chrome')
    if (Browsers?.ubuntu) return Browsers.ubuntu('Chrome')
  } catch {}
  return ['Windows', 'Chrome', '122.0.0.0']
}

function getReconnectDelay(statusCode) {
  if (statusCode === DisconnectReason.restartRequired) return 1000
  if (statusCode === DisconnectReason.connectionClosed) return 2000
  if (statusCode === DisconnectReason.connectionLost) return 3000
  if (statusCode === DisconnectReason.timedOut) return 3500
  return 5000
}

function normalizePairCodeValue(code) {
  return String(code || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
}

function formatPairCode(code) {
  const cleaned = normalizePairCodeValue(code)
  return (cleaned.match(/.{1,4}/g) || [cleaned]).join('-')
}

function pickReactionEmoji(userId, number) {
  const emojis = db.getReactionEmojis(userId, number)
  if (!emojis.length) return '❤️'
  const idx = Math.floor(Math.random() * emojis.length)
  return emojis[idx]
}

class WaSession {
  constructor(userId, number, chatId) {
    this.userId = String(userId)
    this.number = String(number)
    this.chatId = chatId || null
    this.sock = null
    this.state = null
    this.closed = false
    this.pairingRequested = false
    this.pairingAttempts = 0
    this.pendingPairingPromise = null
    this.connectionState = 'idle'
    this.pairingSignalReceivedAt = 0
    this.isNewPairing = false
    this.handledStatusIds = new Map()
    this.lastActivityAt = Date.now()
  }

  touch() {
    this.lastActivityAt = Date.now()
  }

  async start() {
    if (this.sock) return this.sock
    this.closed = false
    this.touch()

    const folder = authFolderFor(this.number)
    await fs.promises.mkdir(folder, { recursive: true })
    const { state, saveCreds } = await useMultiFileAuthState(folder)
    this.state = state

    const version = await getLatestVersion()
    const sock = makeWASocket({
      auth: state,
      version,
      printQRInTerminal: false,
      browser: getBrowserProfile(),
      logger: pino({ level: 'silent' }),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      fireInitQueries: true,
      keepAliveIntervalMs: 30000,
      defaultQueryTimeoutMs: undefined,
      connectTimeoutMs: 60000,
      getMessage: async () => undefined,
    })
    this.sock = sock

    sock.ev.on('creds.update', async () => {
      try {
        await saveCreds()
      } catch (e) {
        console.error(`[${this.number}] saveCreds`, e.message)
      }
    })

    sock.ev.on('connection.update', (update) => {
      this.touch()
      this.onConnectionUpdate(update).catch((e) =>
        console.error(`[${this.number}] connection.update`, e.message)
      )
    })

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      this.touch()
      this.onMessages(messages, `upsert:${type || 'notify'}`).catch((e) =>
        console.error(`[${this.number}] messages.upsert`, e.message)
      )
    })

    sock.ev.on('messaging-history.set', ({ messages, syncType }) => {
      this.touch()
      this.onMessages(messages, `history:${syncType || 'unknown'}`).catch((e) =>
        console.error(`[${this.number}] messaging-history.set`, e.message)
      )
    })

    if (!state?.creds?.registered) {
      db.setStatus(this.userId, this.number, 'pairing')
    }

    return sock
  }

  async ensurePairingCode() {
    const current = db.getPairingCode(this.number)
    if (current) return current
    await this.requestPairingCode(true)
    const timeoutAt = Date.now() + Math.max(10000, Number(config.PAIRING_TIMEOUT_MS || 20000))
    while (Date.now() < timeoutAt) {
      const pairing = db.getPairingCode(this.number)
      if (pairing) return pairing
      await sleep(300)
    }
    throw new Error('pairing_timeout')
  }

  async waitForPairingReady(timeoutMs = Math.max(12000, Number(config.PAIRING_TIMEOUT_MS || 20000))) {
    const timeoutAt = Date.now() + timeoutMs
    while (Date.now() < timeoutAt) {
      if (this.closed) throw new Error('session_closed')
      if (!this.sock) {
        await sleep(250)
        continue
      }
      if (
        this.pairingSignalReceivedAt ||
        this.connectionState === 'connecting' ||
        this.connectionState === 'open'
      ) {
        await sleep(1200)
        return true
      }
      await sleep(250)
    }
    throw new Error('pairing_socket_timeout')
  }

  async onConnectionUpdate(update) {
    const { connection, lastDisconnect, qr } = update || {}
    const statusCode = lastDisconnect?.error?.output?.statusCode
    const registered = !!this.state?.creds?.registered
    if (connection) this.connectionState = connection

    if (!registered && qr) {
      this.pairingSignalReceivedAt = Date.now()
      db.setStatus(this.userId, this.number, 'pairing')
    }

    if (connection === 'connecting' && !registered) {
      db.setStatus(this.userId, this.number, 'pairing')
    }

    if (connection === 'open') {
      this.pairingSignalReceivedAt = 0
      this.pairingAttempts = 0
      this.pairingRequested = false
      this.pendingPairingPromise = null
      db.setStatus(this.userId, this.number, 'connected')
      db.clearPairingCode(this.number)
      db.bumpMetric('totalSuccessfulLinks', 1)
      const emojiText = db.getReactionEmojiText(this.userId, this.number) || '❤️'

      try {
        const ownJid = this.sock.user?.id
        if (ownJid) {
          const greeting =
            `✅ تم ربط رقمك ${this.number} بنجاح!\n\n` +
            `👁 تم تفعيل مشاهدة الحالات تلقائياً\n` +
            `😀 تم تفعيل التفاعل التلقائي على الحالات بالإيموجي ${emojiText} لهذا الرقم.\n\n` +
            `كل حالة جديدة سيتم التعامل معها تلقائياً طالما الجلسة محفوظة ومتصلة.`
          await this.sock.sendMessage(ownJid, { text: greeting })
          db.bumpMetric('totalSelfMessages', 1)
        }
      } catch (e) {
        console.error(`[${this.number}] self greeting`, e.message)
      }

      if (this.isNewPairing) {
        this.isNewPairing = false
        await notify(
          this.chatId,
          `✅ تم ربط الرقم <b>${this.number}</b> بنجاح!\n\n` +
            `⚡ الجلسة محفوظة بشكل دائم وستعود تلقائياً بعد أي إعادة تشغيل.\n` +
            `👁 مشاهدة الحالات: مفعلة\n` +
            `😀 التفاعل التلقائي على الحالات: <b>${emojiText}</b>`
        )
      } else {
        await notify(
          this.chatId,
          `✅ الرقم <b>${this.number}</b> متصل ويعمل بشكل طبيعي.\n\n` +
            `👁 مشاهدة الحالات: مفعلة\n😀 التفاعل التلقائي: <b>${emojiText}</b>`
        )
      }
      return
    }

    if (connection === 'close') {
      this.sock = null
      this.state = null
      this.connectionState = 'close'
      this.pairingSignalReceivedAt = 0
      this.pendingPairingPromise = null

      if (statusCode === DisconnectReason.loggedOut) {
        db.setStatus(this.userId, this.number, 'logged_out')
        db.clearPairingCode(this.number)
        sessions.delete(sessionKey(this.userId, this.number))
        try {
          await fs.promises.rm(authFolderFor(this.number), { recursive: true, force: true })
        } catch {}
        await notify(
          this.chatId,
          `🚪 تم تسجيل خروج الرقم <b>${this.number}</b> من واتساب وحذف بيانات الجلسة.`
        )
        return
      }

      if (this.closed) return

      db.setStatus(this.userId, this.number, 'connecting')
      db.bumpMetric('totalReconnects', 1)
      this.pairingRequested = false
      const delay = getReconnectDelay(statusCode)
      setTimeout(() => {
        if (!this.closed) {
          this.start().catch((e) => console.error(`[${this.number}] reconnect`, e.message))
        }
      }, delay)
    }
  }

  async requestPairingCode(force = false) {
    const cached = db.getPairingCode(this.number)
    if (cached && !force) return cached
    if (this.pendingPairingPromise) return this.pendingPairingPromise

    this.pendingPairingPromise = (async () => {
      if (!this.sock || this.closed) {
        await this.start()
      }
      if (!this.sock || this.closed) throw new Error('session_unavailable')
      if (this.state?.creds?.registered) throw new Error('already_registered')

      let lastError = null
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          this.pairingRequested = true
          await this.waitForPairingReady()
          const requestedCode = await this.sock.requestPairingCode(String(this.number).replace(/\D/g, ''))
          const rawCode = normalizePairCodeValue(requestedCode)
          if (rawCode.length !== 8) {
            throw new Error('empty_or_invalid_pairing_code')
          }
          const code = formatPairCode(rawCode)
          this.isNewPairing = true
          this.pairingAttempts = 0
          return db.setPairingCode(this.number, rawCode, code, config.PAIRING_CODE_TTL_SECONDS)
        } catch (e) {
          lastError = e
          this.pairingAttempts = attempt
          this.pairingRequested = false
          if (attempt < 3 && !this.closed) {
            await sleep(2500)
          }
        }
      }
      throw lastError || new Error('pairing_failed')
    })()

    try {
      return await this.pendingPairingPromise
    } finally {
      this.pendingPairingPromise = null
    }
  }

  isStatusMessage(msg) {
    return !!msg && !msg.key?.fromMe && msg.key?.remoteJid === STATUS_JID
  }

  extractStatusParticipant(msg) {
    const candidates = [
      msg?.key?.participant,
      msg?.participant,
      msg?.message?.protocolMessage?.key?.participant,
      msg?.message?.extendedTextMessage?.contextInfo?.participant,
      msg?.message?.imageMessage?.contextInfo?.participant,
      msg?.message?.videoMessage?.contextInfo?.participant,
      msg?.message?.audioMessage?.contextInfo?.participant,
      msg?.message?.reactionMessage?.key?.participant,
      msg?.message?.senderKeyDistributionMessage?.groupId,
    ]

    for (const candidate of candidates) {
      const value = String(candidate || '').trim()
      if (value && value !== STATUS_JID) return value
    }
    return ''
  }

  buildStatusDedupKey(msg) {
    const id = String(msg?.key?.id || '').trim()
    const participant = this.extractStatusParticipant(msg)
    return `${participant || 'unknown'}:${id || 'no-id'}`
  }

  pruneHandledStatuses() {
    const maxEntries = 1500
    if (this.handledStatusIds.size <= maxEntries) return
    const excess = this.handledStatusIds.size - 1000
    const keys = Array.from(this.handledStatusIds.keys()).slice(0, excess)
    for (const key of keys) this.handledStatusIds.delete(key)
  }

  async markStatusSeen(msg, participant) {
    if (!this.sock || !msg?.key?.id) return false
    const key = {
      ...msg.key,
      remoteJid: STATUS_JID,
      participant: participant || msg.key?.participant,
    }
    try {
      await this.sock.readMessages([key])
      db.bumpStatusView(this.number)
      return true
    } catch (e) {
      console.error(`[${this.number}] mark seen`, e.message)
      return false
    }
  }

  async reactToStatus(msg, participant, source = 'status') {
    if (!this.sock || !msg?.key) return false
    const emoji = pickReactionEmoji(this.userId, this.number)
    const statusParticipant = participant || this.extractStatusParticipant(msg)

    if (!statusParticipant || statusParticipant === STATUS_JID) {
      return false
    }

    const reactionKey = {
      ...msg.key,
      remoteJid: STATUS_JID,
      participant: statusParticipant,
      fromMe: false,
    }

    try {
      await this.sock.sendMessage(
        STATUS_JID,
        {
          react: {
            text: emoji,
            key: reactionKey,
          },
        },
        {
          statusJidList: [statusParticipant],
        }
      )
      db.addStatusReaction(this.number, {
        emoji,
        participantNumber: statusParticipant.split('@')[0],
        participantLabel: statusParticipant.split('@')[0],
        reactedAt: new Date().toISOString(),
        source,
      })
      return true
    } catch (e) {
      console.error(`[${this.number}] react status`, e.message)
      return false
    }
  }

  async handleSingleStatus(msg, source = 'unknown') {
    if (!this.isStatusMessage(msg)) return
    const record = db.getNumber(this.userId, this.number)
    if (!record) return

    const dedupKey = this.buildStatusDedupKey(msg)
    if (this.handledStatusIds.has(dedupKey)) return
    this.handledStatusIds.set(dedupKey, Date.now())
    this.pruneHandledStatuses()

    const participant = this.extractStatusParticipant(msg)
    await sleep(randDelayMs())

    if (record.autoViewStatus !== false) {
      await this.markStatusSeen(msg, participant)
    }

    if (record.autoReactStatus !== false) {
      await this.reactToStatus(msg, participant, source)
    }
  }

  async onMessages(messages, source = 'unknown') {
    for (const msg of messages || []) {
      await this.handleSingleStatus(msg, source)
    }
  }
}

async function startSession(userId, number, chatId) {
  const key = sessionKey(userId, number)
  let session = sessions.get(key)
  if (!session) {
    session = new WaSession(userId, number, chatId)
    sessions.set(key, session)
  }
  session.chatId = chatId || session.chatId || null
  await session.start()
  return session
}

function getSession(userId, number) {
  return sessions.get(sessionKey(userId, number)) || null
}

function getSessionByNumber(number) {
  const normalized = String(number || '').replace(/\D/g, '')
  for (const session of sessions.values()) {
    if (session.number === normalized) return session
  }
  return null
}

async function stopSession(userId, number, logout = true) {
  const key = sessionKey(userId, number)
  const session = sessions.get(key)
  if (!session) return false
  session.closed = true
  sessions.delete(key)
  const sock = session.sock
  try {
    if (sock) {
      if (logout) await sock.logout()
      if (typeof sock.end === 'function') sock.end(undefined)
    }
  } catch (e) {
    console.error('[stop session]', e.message)
  }
  if (logout) {
    try {
      await fs.promises.rm(authFolderFor(number), { recursive: true, force: true })
    } catch {}
  }
  return true
}

async function ensureNumberSession(number) {
  const found = db.getNumberWithOwner(number)
  if (!found) throw new Error('not_found')
  return startSession(found.userId, found.record.number, found.user.chatId)
}

async function generatePairingCode(number) {
  const session = await ensureNumberSession(number)
  return session.ensurePairingCode()
}

async function resumeAll() {
  const all = db.getAllNumbers()
  for (let i = 0; i < all.length; i += 1) {
    const item = all[i]
    setTimeout(() => {
      startSession(item.userId, item.number, item.chatId).catch((e) =>
        console.error('[resume all]', e.message)
      )
    }, i * Math.max(500, Number(config.SESSION_RECONNECT_SPREAD_MS || 3000)))
  }
  if (all.length) console.log(`♻️ استعادة ${all.length} جلسة محفوظة...`)
}

function applyLiveSettings(number) {
  const found = db.getNumberWithOwner(number)
  if (!found) return null
  const session = getSession(found.userId, found.record.number)
  return {
    hasSession: !!session,
    status: found.record.status,
    emojis: db.getReactionEmojiText(found.userId, found.record.number),
  }
}

function getRuntimeStats() {
  return {
    activeSessions: sessions.size,
    startedAt: runtime.startedAt,
    uptimeMs: Date.now() - new Date(runtime.startedAt).getTime(),
  }
}

function startHealthMonitor() {
  setInterval(async () => {
    const all = db.getAllNumbers()
    for (const item of all) {
      const session = getSession(item.userId, item.number)
      if (!session) {
        startSession(item.userId, item.number, item.chatId).catch((e) =>
          console.error('[health revive]', e.message)
        )
        continue
      }
      if (session.closed) continue
      if (!session.sock && item.status !== 'logged_out') {
        session.start().catch((e) => console.error('[health start]', e.message))
      }
    }
  }, Math.max(15000, Number(config.SESSION_HEALTHCHECK_MS || 60000)))
}

module.exports = {
  startSession,
  stopSession,
  getSession,
  getSessionByNumber,
  setNotifier,
  resumeAll,
  generatePairingCode,
  ensureNumberSession,
  applyLiveSettings,
  getRuntimeStats,
  startHealthMonitor,
}