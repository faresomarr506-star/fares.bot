/**
 * مدير جلسات واتساب (Baileys)
 * -------------------------------------------------
 * - كل رقم له جلسة مستقلة تماماً (مجلد Auth خاص به + إعداداته الخاصة)
 * - ربط الأرقام يتم عبر كود الاقتران (Pairing Code) يرسله البوت للمستخدم
 * - تحسين جلسة الاقتران حتى يكتمل الربط مباشرة بعد إدخال الكود في واتساب
 * - مشاهدة الحالات والتفاعل عليها تلقائياً مباشرة بعد الربط
 */
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
const sessions = new Map() // المفتاح: `${userId}:${number}` => WaSession
let latestVersionPromise = null

/* ---------- الإشعارات إلى تيليجرام ---------- */
let notifyFn = null

function setNotifier(fn) {
  notifyFn = fn
}

async function notify(chatId, text) {
  if (!notifyFn || !chatId) return
  try {
    await notifyFn(chatId, text)
  } catch (e) {
    console.error('[إشعار]', e.message)
  }
}

const sessionKey = (userId, number) => `${userId}:${number}`
const authFolderFor = (number) => path.join(config.SESSIONS_DIR, String(number || '').replace(/\D/g, ''))

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
        console.error('[Baileys version]', e.message)
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

/* =========================================================
 *  جلسة واتساب واحدة (رقم واحد)
 * ========================================================= */
class WaSession {
  constructor(userId, number, chatId) {
    this.userId = userId
    this.number = number
    this.chatId = chatId
    this.sock = null
    this.state = null
    this.closed = false
    this.pairingRequested = false
    this.pairingAttempts = 0
    this.isNewPairing = false
    this.handledStatusIds = new Map()
  }

  async start() {
    if (this.sock) return this.sock
    this.closed = false

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

    sock.ev.on('connection.update', (u) => {
      this.onConnectionUpdate(u).catch((e) => console.error(`[${this.number}] connection.update`, e.message))
    })

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      this.onMessages(messages, `upsert:${type || 'notify'}`).catch((e) =>
        console.error(`[${this.number}] messages.upsert`, e.message)
      )
    })

    sock.ev.on('messaging-history.set', ({ messages, syncType }) => {
      this.onMessages(messages, `history:${syncType || 'unknown'}`).catch((e) =>
        console.error(`[${this.number}] messaging-history.set`, e.message)
      )
    })

    if (!state?.creds?.registered && !this.pairingRequested) {
      this.pairingRequested = true
      db.setStatus(this.userId, this.number, 'pairing')
      setTimeout(() => {
        this.requestPairingCode().catch((e) => console.error(`[${this.number}] pairing`, e.message))
      }, 1500)
    }

    return sock
  }

  /* ---------- أحداث الاتصال + كود الاقتران ---------- */
  async onConnectionUpdate(update) {
    const { connection, lastDisconnect } = update || {}
    const statusCode = lastDisconnect?.error?.output?.statusCode
    const registered = !!this.state?.creds?.registered

    if (connection === 'connecting' && !registered) {
      db.setStatus(this.userId, this.number, 'pairing')
    }

    if (connection === 'open') {
      this.pairingAttempts = 0
      this.pairingRequested = false
      db.setStatus(this.userId, this.number, 'connected')
      const emoji = db.getEmoji(this.userId, this.number) || '❤️'

      // ✅ إرسال نفس رسالة الترحيب إلى الرقم نفسه (داخل واتساب) فور نجاح الربط
      // نفس النص الذي يُرسل إلى تيليجرام حتى يعرف المستخدم أن الربط تم.
      try {
        const ownJid = this.sock.user?.id
        if (ownJid) {
          const greeting =
            `✅ تم ربط رقمك ${this.number} بنجاح!\n\n` +
            `👁 تم تفعيل مشاهدة الحالات تلقائياً\n` +
            `😀 تم تفعيل التفاعل التلقائي على الحالات بالإيموجي ${emoji} لهذا الرقم.\n\n` +
            `كل حالة جديدة ستصلك عليها علامة قراءة + قلب ${emoji} تلقائياً.`
          await this.sock.sendMessage(ownJid, { text: greeting })
        }
      } catch (e) {
        console.error(
          `[${this.number}] تعذر إرسال رسالة الترحيب للواتساب نفسه:`,
          e?.message || e
        )
      }

      if (this.isNewPairing) {
        this.isNewPairing = false
        await notify(
          this.chatId,
          `✅ تم ربط الرقم <b>${this.number}</b> بنجاح!\n\n` +
            `⚡ تم اعتماد الجلسة مباشرة بعد إدخال كود الاقتران بدون تعليق.\n` +
            `👁 تمت تفعيل مشاهدة الحالات تلقائياً\n` +
            `😀 وتم تفعيل التفاعل التلقائي على الحالات بالإيموجي <b>${emoji}</b> لهذا الرقم.\n` +
            `📩 وتم إرسال رسالة الترحيب إلى الرقم داخل واتساب نفسه.`
        )
      } else {
        await notify(
          this.chatId,
          `✅ الرقم <b>${this.number}</b> متصل ويعمل بشكل طبيعي\n\n` +
            `👁 مشاهدة الحالات: مفعلة\n😀 التفاعل التلقائي على الحالات: <b>${emoji}</b>`
        )
      }

      // ضمان أن الحالة والتفاعل مفعّلان تلقائياً لكل رقم مربوط
      const record = db.getNumber(this.userId, this.number)
      if (record) {
        if (record.autoViewStatus === false) record.autoViewStatus = true
        if (record.autoReactStatus === false) record.autoReactStatus = true
      }
      console.log(
        `[${this.number}] 🟢 الجلسة جاهزة — مشاهدة + تفاعل الحالات مفعّلان تلقائياً`
      )
      return
    }

    if (connection === 'close') {
      this.sock = null
      this.state = null

      if (statusCode === DisconnectReason.loggedOut) {
        db.setStatus(this.userId, this.number, 'logged_out')
        sessions.delete(sessionKey(this.userId, this.number))
        try {
          await fs.promises.rm(authFolderFor(this.number), { recursive: true, force: true })
        } catch {}
        await notify(
          this.chatId,
          `🚪 تم تسجيل خروج الرقم <b>${this.number}</b> من واتساب (حذف الجلسة).\nاربط الرقم مرة أخرى من البوت متى شئت.`
        )
        return
      }

      if (this.closed) return

      db.setStatus(this.userId, this.number, 'connecting')
      this.pairingRequested = false
      const delay = getReconnectDelay(statusCode)

      setTimeout(() => {
        if (!this.closed) {
          this.start().catch((e) => console.error(`[${this.number}] reconnect`, e.message))
        }
      }, delay)
    }
  }

  /* ---------- الحصول على كود الاقتران وإرساله عبر البوت ---------- */
  async requestPairingCode() {
    try {
      if (!this.sock || this.closed) return
      if (this.state?.creds?.registered) return

      const code = await this.sock.requestPairingCode(String(this.number).replace(/\D/g, ''))
      const formatted = (String(code || '').match(/.{1,4}/g) || [String(code || '')]).join('-')
      this.isNewPairing = true

      await notify(
        this.chatId,
        `🔗 <b>كود الاقتران</b> للرقم <b>${this.number}</b>:\n\n` +
          `<code>${formatted}</code>\n\n` +
          `📲 <b>خطوات الربط على جوالك:</b>\n` +
          `1️⃣ افتح واتساب للرقم المطلوب ربطه\n` +
          `2️⃣ الإعدادات ← الأجهزة المرتبطة ← ربط جهاز\n` +
          `3️⃣ اختر «الاقتران برقم بدلاً من رمز QR»\n` +
          `4️⃣ أدخل الكود أعلاه الآن\n\n` +
          `⚡ بعد إدخال الكود سيتم تثبيت الجلسة مباشرة تلقائياً إذا كان الرقم صحيحاً واتصال الإنترنت مستقر.\n` +
          `⏳ الكود صالح لفترة قصيرة فقط.`
      )
    } catch (e) {
      console.error(`[${this.number}] فشل طلب كود الاقتران:`, e.message)
      this.pairingAttempts++
      this.pairingRequested = false

      if (this.pairingAttempts < 3 && !this.closed) {
        setTimeout(() => {
          if (!this.closed && !(this.state?.creds?.registered)) {
            this.pairingRequested = true
            this.requestPairingCode().catch((err) => console.error(`[${this.number}] retry pairing`, err.message))
          }
        }, 8000)
        return
      }

      const extra = String(e.message || '').includes('rate-overlimit')
        ? '\n⏳ واتساب قيّد طلبات الاقتران مؤقتاً لهذا الرقم، انتظر عدة دقائق ثم أعد المحاولة.'
        : ''

      await notify(
        this.chatId,
        `❌ تعذر الحصول على كود الاقتران للرقم <b>${this.number}</b> بعد عدة محاولات.\n` +
          `تأكد من أن الرقم صحيح ومن اتصال السيرفر بالإنترنت ثم أعد المحاولة.${extra}`
      )
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
      return true
    } catch (e) {
      console.error(`[${this.number}] فشل تعليم الحالة كمشاهدة:`, e.message)
      return false
    }
  }

  async reactToStatus(msg, participant) {
    if (!this.sock || !msg?.key) return false

    const emoji = db.getEmoji(this.userId, this.number) || '❤️'
    const statusParticipant = participant || this.extractStatusParticipant(msg)

    if (!statusParticipant || statusParticipant === STATUS_JID) {
      console.error(
        `[${this.number}] تعذر تحديد صاحب الحالة (participant) — تخطي التفاعل`
      )
      return false
    }

    // مفتاح التفاعل يجب أن يطابق مفتاح الحالة الأصلية بالظبط:
    // remoteJid = status@broadcast و participant = صاحب الحالة
    // و fromMe = false حتى يَعتبِرها واتساب تفاعل وليس رسالة صادرة
    const reactionKey = {
      ...msg.key,
      remoteJid: STATUS_JID,
      participant: statusParticipant,
      fromMe: false,
    }

    // قائمة مَن شاهد/تفاعل على الحالة (statusJidList):
    // يجب أن تحتوي فقط على صاحب الحالة (المشاهِد الذي يتفاعل)
    // وليس رقم البوت نفسه — وإلا فإن واتساب يتجاهل التفاعل بصمت.
    const statusJidList = [statusParticipant]

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
          statusJidList,
        }
      )
      console.log(
        `[${this.number}] ✅ تم إرسال التفاعل ${emoji} على الحالة لـ ${statusParticipant}`
      )
      return true
    } catch (e) {
      console.error(
        `[${this.number}] ❌ فشل التفاعل على الحالة:`,
        e?.message || e,
        e?.output?.payload || ''
      )
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
      const reacted = await this.reactToStatus(msg, participant)
      if (reacted) {
        console.log(
          `[${this.number}] تمت مشاهدة الحالة والتفاعل عليها ${record.emoji || '❤️'} من المصدر ${source}`
        )
      }
    }
  }

  /* ---------- استقبال الرسائل والتعامل مع الحالات ---------- */
  async onMessages(messages, source = 'unknown') {
    for (const msg of messages || []) {
      await this.handleSingleStatus(msg, source)
    }
  }
}

/* =========================================================
 *  واجهة إدارة الجلسات
 * ========================================================= */

async function startSession(userId, number, chatId) {
  const key = sessionKey(userId, number)
  let ses = sessions.get(key)
  if (!ses) {
    ses = new WaSession(userId, number, chatId)
    sessions.set(key, ses)
  }
  ses.chatId = chatId
  await ses.start()
  return ses
}

function getSession(userId, number) {
  return sessions.get(sessionKey(userId, number)) || null
}

async function stopSession(userId, number, logout = true) {
  const key = sessionKey(userId, number)
  const ses = sessions.get(key)
  if (!ses) return false
  ses.closed = true
  sessions.delete(key)
  const sock = ses.sock
  try {
    if (sock) {
      if (logout) await sock.logout()
      if (typeof sock.end === 'function') sock.end(undefined)
    }
  } catch (e) {
    console.error('[إيقاف]', e.message)
  }
  if (logout) {
    try {
      await fs.promises.rm(authFolderFor(number), { recursive: true, force: true })
    } catch {}
  }
  return true
}

async function resumeAll() {
  const all = db.getAllNumbers()
  for (let i = 0; i < all.length; i++) {
    const item = all[i]
    setTimeout(() => {
      startSession(item.userId, item.number, item.chatId).catch((e) =>
        console.error('[استعادة]', e.message)
      )
    }, i * 3000)
  }
  if (all.length) console.log(`♻️ استعادة ${all.length} جلسة واتساب محفوظة...`)
}

module.exports = { startSession, stopSession, getSession, setNotifier, resumeAll }
