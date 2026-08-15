const path = require('path')
const express = require('express')
const TelegramBot = require('node-telegram-bot-api')
const emojiRegex = require('emoji-regex')
const config = require('./config')
const db = require('./db')
const whatsapp = require('./whatsapp')

const app = express()
const PUBLIC_DIR = path.join(__dirname, 'public')
const pending = new Map()
let bot = null

const HTML_PAGES = {
  '/': 'index.html',
  '/admin': 'admin.html',
  '/panel': 'panel.html',
  '/downloader': 'downloader.html',
  '/ai': 'ai.html',
  '/monitor': 'monitor.html',
  '/bot': 'bot.html',
  '/bot/about': 'about.html',
  '/bot/contact': 'contact.html',
  '/bot/settings': 'settings.html',
  '/bot/faq': 'faq.html',
  '/bot/deploy': 'deploy.html',
  '/bot/autosave': 'autosave.html',
  '/bot/autoreply': 'autoreply.html',
}

db.load()

app.disable('x-powered-by')
app.use(express.json({ limit: '1mb' }))
app.use(express.urlencoded({ extended: true }))
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }))

function isAuthorized(userId) {
  if (!config.ONLY_ADMINS) return true
  return config.ADMIN_IDS.includes(Number(userId))
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function normalizeNumber(raw) {
  return db.normalizeNumber(raw)
}

function parseReactionEmojis(text) {
  const matches = String(text || '').match(emojiRegex()) || []
  return db.normalizeReactionEmojis(matches)
}

function reactionTextForRecord(record) {
  return db.emojisText(record?.reactionEmojis || record?.emoji || ['❤️'])
}

function statusText(status) {
  const map = {
    new: '🆕 جديد',
    pairing: '🔗 بانتظار كود الاقتران',
    connecting: '🔄 إعادة اتصال',
    connected: '🟢 متصل',
    logged_out: '🔴 مسجل خروجه',
  }
  return map[status] || escapeHtml(status || 'غير معروف')
}

function mainMenuKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '😀 تغيير إيموجيات التفاعل', callback_data: 'emoji_start' }],
        [{ text: '➕ ربط رقم جديد', callback_data: 'link' }],
        [{ text: '📋 أرقامي المربوطة', callback_data: 'list' }],
        [{ text: '🗑 حذف رقم', callback_data: 'del_list' }],
      ],
    },
  }
}

function buildDashboardText(userId) {
  const user = db.getUser(userId)
  const numbers = user?.numbers || []
  const lines = numbers.length
    ? numbers
        .map(
          (item, index) =>
            `${index + 1}. 📱 <b>${escapeHtml(item.number)}</b>\n` +
            `   😀 إيموجيات التفاعل: <b>${escapeHtml(reactionTextForRecord(item))}</b>\n` +
            `   📶 الحالة: ${statusText(item.status)}`
        )
        .join('\n\n')
    : '— لا توجد أرقام مربوطة حالياً.'

  return (
    `👋 أهلاً بك في منصة ربط واتساب والتفاعل مع الحالات!\n\n` +
    `📌 <b>ما الذي يفعله البوت:</b>\n` +
    `• ربط رقم واتساب عبر كود الاقتران مباشرة\n` +
    `• حفظ الجلسات بشكل دائم والعودة التلقائية بعد إعادة التشغيل\n` +
    `• مشاهدة الحالات والتفاعل عليها بشكل مستمر لكل رقم مربوط\n` +
    `• دعم أكثر من إيموجي للتفاعل لكل رقم\n\n` +
    `📋 <b>الأرقام الحالية:</b>\n${lines}\n\n` +
    `🌐 لوحة الموقع والإعدادات أصبحت مرتبطة بنفس قاعدة البوت، وأي تغيير من الموقع يُطبق مباشرة على الرقم.`
  )
}

async function sendTelegramMessage(chatId, text, extra = {}) {
  if (!bot || !chatId) return null
  try {
    return await bot.sendMessage(chatId, text, { parse_mode: 'HTML', ...extra })
  } catch (e) {
    console.error('[telegram send]', e.message)
    return null
  }
}

async function showDashboard(chatId, userId, options = {}) {
  if (!bot) return null
  db.ensureUser(userId, chatId)
  const text = buildDashboardText(userId)
  const messageId = options.messageId || db.getDashboardMessage(userId)
  const payload = { parse_mode: 'HTML', ...mainMenuKeyboard() }

  if (messageId && !options.forceNew) {
    try {
      await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: messageId,
        ...payload,
      })
      db.setDashboardMessage(userId, messageId)
      return { message_id: messageId, edited: true }
    } catch (e) {
      if (String(e.message || '').includes('message is not modified')) {
        return { message_id: messageId, edited: true }
      }
      db.clearDashboardMessage(userId)
    }
  }

  const sent = await bot.sendMessage(chatId, text, payload)
  db.setDashboardMessage(userId, sent.message_id)
  return sent
}

async function refreshDashboardByChat(chatId) {
  if (!bot || !chatId) return
  const user = db.getUserByChatId(chatId)
  if (!user) return
  try {
    await showDashboard(chatId, user.userId)
  } catch (e) {
    console.error('[refresh dashboard]', e.message)
  }
}

async function notifyLinkedNumber(number, text) {
  const found = db.getNumberWithOwner(number)
  if (!found) return false
  const session = whatsapp.getSession(found.userId, found.record.number)
  if (!session?.sock?.user?.id) return false
  try {
    await session.sock.sendMessage(session.sock.user.id, { text })
    return true
  } catch (e) {
    console.error('[notify linked number]', e.message)
    return false
  }
}

whatsapp.setNotifier(async (chatId, text) => {
  await sendTelegramMessage(chatId, text)
  await refreshDashboardByChat(chatId)
})

async function linkNumber(chatId, userId, rawNumber) {
  const number = normalizeNumber(rawNumber)
  if (!/^\d{8,15}$/.test(number)) {
    return sendTelegramMessage(
      chatId,
      '❌ صيغة الرقم غير صحيحة. أرسل الرقم بالصيغة الدولية بدون + وبدون مسافات.'
    )
  }

  try {
    db.addNumber(userId, number, chatId)
  } catch (e) {
    if (e.message === 'already_linked') {
      return sendTelegramMessage(chatId, '⚠️ هذا الرقم مربوط بحسابك بالفعل.')
    }
    if (e.message === 'linked_other') {
      return sendTelegramMessage(
        chatId,
        '⚠️ هذا الرقم مربوط مسبقاً داخل النظام. لا يمكن ربطه بحسابين في نفس الوقت.'
      )
    }
    throw e
  }

  await showDashboard(chatId, userId).catch(() => {})
  await sendTelegramMessage(
    chatId,
    `⏳ جاري تجهيز كود الاقتران للرقم <b>${escapeHtml(number)}</b>...`
  )

  try {
    await whatsapp.startSession(userId, number, chatId)
  } catch (e) {
    console.error('[start session]', e.message)
    await sendTelegramMessage(chatId, '❌ تعذر بدء الجلسة: ' + escapeHtml(e.message))
  }
}

function installTelegramBot() {
  if (!config.TELEGRAM_TOKEN || config.WEB_ONLY_MODE) {
    console.log('ℹ️ TELEGRAM_TOKEN غير موجود أو WEB_ONLY_MODE مفعل — سيتم تشغيل الموقع فقط.')
    return
  }

  bot = new TelegramBot(config.TELEGRAM_TOKEN, { polling: true })

  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id
    const userId = String(msg.from.id)
    if (!isAuthorized(userId)) {
      await sendTelegramMessage(chatId, '⛔ أنت غير مصرح لك باستخدام هذا البوت.')
      return
    }
    db.ensureUser(userId, chatId)
    await showDashboard(chatId, userId, { forceNew: true }).catch(() => {})
  })

  bot.on('callback_query', async (query) => {
    const chatId = query.message?.chat?.id
    const userId = String(query.from.id)
    const data = query.data || ''
    if (!chatId) return
    if (!isAuthorized(userId)) {
      await bot.answerCallbackQuery(query.id, { text: '⛔ غير مصرح' }).catch(() => {})
      return
    }

    try {
      if (data === 'emoji_start') {
        await bot.answerCallbackQuery(query.id).catch(() => {})
        const numbers = db.getUser(userId)?.numbers || []
        if (!numbers.length) {
          await sendTelegramMessage(chatId, '⚠️ لا يوجد لديك أرقام مربوطة بعد.')
          return
        }
        const keyboard = numbers.map((item) => [
          {
            text: `📱 ${item.number} (${reactionTextForRecord(item)})`,
            callback_data: `emoji:${item.number}`,
          },
        ])
        keyboard.push([{ text: '🔙 رجوع', callback_data: 'back' }])
        await sendTelegramMessage(chatId, '👇 اختر الرقم الذي تريد تغيير إيموجياته:', {
          reply_markup: { inline_keyboard: keyboard },
        })
        return
      }

      if (data.startsWith('emoji:')) {
        const number = data.slice(6)
        pending.set(chatId, { action: 'set_emoji', userId, number })
        await sendTelegramMessage(
          chatId,
          `✍️ أرسل الآن <b>أكثر من إيموجي أو إيموجي واحد</b> للرقم <b>${escapeHtml(number)}</b>\n\n` +
            `مثال: ❤️ 🔥 😂 👍`
        )
        return
      }

      if (data === 'link') {
        pending.set(chatId, { action: 'add_number', userId })
        await sendTelegramMessage(
          chatId,
          `📲 أرسل رقم واتساب بالصيغة الدولية بدون + وبدون مسافات.\n\n<code>مثال: 9665XXXXXXXX</code>`
        )
        return
      }

      if (data === 'list') {
        const numbers = db.getUser(userId)?.numbers || []
        if (!numbers.length) {
          await sendTelegramMessage(chatId, '⚠️ لا توجد أرقام مربوطة.')
          return
        }
        const lines = numbers.map(
          (item, index) =>
            `${index + 1}. 📱 <b>${escapeHtml(item.number)}</b>\n` +
            `   😀 الإيموجيات: <b>${escapeHtml(reactionTextForRecord(item))}</b> | الحالة: ${statusText(item.status)}`
        )
        await sendTelegramMessage(chatId, `📋 أرقامك المربوطة (${numbers.length}):\n\n${lines.join('\n\n')}`)
        return
      }

      if (data === 'del_list') {
        const numbers = db.getUser(userId)?.numbers || []
        if (!numbers.length) {
          await sendTelegramMessage(chatId, '⚠️ لا توجد أرقام لحذفها.')
          return
        }
        const keyboard = numbers.map((item) => [{ text: `🗑 ${item.number}`, callback_data: `del:${item.number}` }])
        keyboard.push([{ text: '🔙 رجوع', callback_data: 'back' }])
        await sendTelegramMessage(chatId, 'اختر الرقم الذي تريد حذفه:', {
          reply_markup: { inline_keyboard: keyboard },
        })
        return
      }

      if (data.startsWith('del:')) {
        const number = data.slice(4)
        await sendTelegramMessage(
          chatId,
          `⚠️ هل أنت متأكد من حذف الرقم <b>${escapeHtml(number)}</b>؟ سيتم تسجيل خروجه وحذف جلسته.`,
          {
            reply_markup: {
              inline_keyboard: [
                [
                  { text: '✅ نعم احذف', callback_data: `confirm_del:${number}` },
                  { text: '❌ إلغاء', callback_data: 'del_list' },
                ],
              ],
            },
          }
        )
        return
      }

      if (data.startsWith('confirm_del:')) {
        const number = data.slice(12)
        await whatsapp.stopSession(userId, number, true)
        db.removeNumber(userId, number)
        await sendTelegramMessage(chatId, `🗑 تم حذف الرقم <b>${escapeHtml(number)}</b> بنجاح.`)
        await showDashboard(chatId, userId).catch(() => {})
        return
      }

      if (data === 'back') {
        await showDashboard(chatId, userId, { messageId: query.message.message_id }).catch(() => {})
      }
    } catch (e) {
      console.error('[callback]', e.message)
    }
  })

  bot.on('message', async (msg) => {
    const chatId = msg.chat.id
    const userId = String(msg.from.id)
    if (!isAuthorized(userId) || !msg.text) return

    if (msg.text.startsWith('/')) {
      const parts = msg.text.split(/\s+/)
      if (parts[0] === '/add') {
        const num = normalizeNumber(parts[1])
        if (!num) {
          await sendTelegramMessage(chatId, 'الاستخدام: /add 9665XXXXXXXX')
          return
        }
        await linkNumber(chatId, userId, num)
      }
      if (parts[0] === '/remove') {
        const num = normalizeNumber(parts[1])
        if (!num) {
          await sendTelegramMessage(chatId, 'الاستخدام: /remove 9665XXXXXXXX')
          return
        }
        const owned = db.getUser(userId)?.numbers?.some((item) => item.number === num)
        if (!owned) {
          await sendTelegramMessage(chatId, '⚠️ هذا الرقم غير مربوط بحسابك.')
          return
        }
        await whatsapp.stopSession(userId, num, true)
        db.removeNumber(userId, num)
        await sendTelegramMessage(chatId, `🗑 تم حذف الرقم <b>${escapeHtml(num)}</b>.`)
        await showDashboard(chatId, userId).catch(() => {})
      }
      return
    }

    const state = pending.get(chatId)
    if (!state) return

    if (state.action === 'add_number') {
      pending.delete(chatId)
      await linkNumber(chatId, userId, msg.text)
      return
    }

    if (state.action === 'set_emoji') {
      pending.delete(chatId)
      const emojis = parseReactionEmojis(msg.text)
      if (!emojis.length) {
        await sendTelegramMessage(chatId, '❌ لم أجد أي إيموجي في رسالتك.')
        return
      }
      try {
        db.setReactionEmojis(state.userId, state.number, emojis)
        whatsapp.applyLiveSettings(state.number)
        await sendTelegramMessage(
          chatId,
          `✅ تم حفظ الإيموجيات <b>${escapeHtml(db.emojisText(emojis))}</b> للرقم <b>${escapeHtml(state.number)}</b>.\n` +
            `وسيتم تطبيقها مباشرة على التفاعلات الجديدة.`
        )
        await showDashboard(chatId, state.userId).catch(() => {})
      } catch (e) {
        await sendTelegramMessage(chatId, '❌ الرقم غير موجود في حسابك.')
      }
    }
  })

  console.log('🤖 بوت تيليجرام يعمل...')
}

function jsonOk(res, payload = {}) {
  res.json({ ok: true, ...payload })
}

function jsonError(res, status, message, extra = {}) {
  res.status(status).json({ ok: false, error: message, ...extra })
}

function validateNumberInput(number, res) {
  const normalized = normalizeNumber(number)
  if (!/^\d{8,15}$/.test(normalized)) {
    jsonError(res, 400, 'صيغة الرقم غير صحيحة.')
    return null
  }
  return normalized
}

function authenticatePanel(req, res, next) {
  const number = validateNumberInput(req.params.number, res)
  if (!number) return
  const token = String(req.headers['x-panel-token'] || '')
  if (!db.verifyPanelToken(number, token)) {
    jsonError(res, 401, 'انتهت الجلسة أو التوكن غير صالح.')
    return
  }
  req.panelNumber = number
  req.panelToken = token
  req.panelOwner = db.getNumberWithOwner(number)
  next()
}

function authenticateAdmin(req, res, next) {
  const token = String(req.headers['x-admin-token'] || '')
  if (token !== config.ADMIN_PANEL_TOKEN) {
    jsonError(res, 401, 'توكن الإدارة غير صحيح.')
    return
  }
  next()
}

function ensureNumberExists(number, ownerUserId = null, ownerChatId = null) {
  const found = db.getNumberWithOwner(number)
  if (found) return found
  const userId = ownerUserId || `web-${number}`
  db.addNumber(userId, number, ownerChatId)
  return db.getNumberWithOwner(number)
}

function buildPanelPayload(number) {
  const found = db.getNumberWithOwner(number)
  if (!found) return null
  const settings = db.getSettingsByNumber(number)
  const wallet = db.getWallet(number)
  const reactions = db.getStatusReactions(number)
  return {
    number,
    status: found.record.status,
    emoji: db.getReactionEmojiText(found.userId, number),
    settings,
    wallet,
    store: db.getStoreOffers(number),
    reactions,
  }
}

app.get('/health', (req, res) => {
  jsonOk(res, { status: 'ok', runtime: whatsapp.getRuntimeStats() })
})

app.get('/api/public/config', (req, res) => {
  jsonOk(res, { config: db.buildPublicConfig(whatsapp.getRuntimeStats()) })
})

app.get('/api/public/stats', (req, res) => {
  jsonOk(res, { stats: db.buildPublicStats(whatsapp.getRuntimeStats()) })
})

app.get('/api/public/comments', (req, res) => {
  jsonOk(res, { comments: db.listComments() })
})

app.post('/api/public/comments', (req, res) => {
  const name = String(req.body?.name || '').trim()
  const message = String(req.body?.message || '').trim()
  const contact = String(req.body?.contact || '').trim()
  if (!name || !message) {
    jsonError(res, 400, 'الاسم والرسالة مطلوبان.')
    return
  }
  const comment = db.addComment({ name, contact, message })
  jsonOk(res, { comment })
})

app.post('/api/public/pairing-code', async (req, res) => {
  const number = validateNumberInput(req.body?.number, res)
  if (!number) return
  const accepted = !!req.body?.accepted
  if (!accepted) {
    jsonError(res, 400, 'يجب تأكيد استخدام الرقم للربط.')
    return
  }

  try {
    ensureNumberExists(number)
    const pairing = await whatsapp.generatePairingCode(number)
    jsonOk(res, {
      number,
      code: pairing.code,
      rawCode: pairing.rawCode,
      expiresAt: pairing.expiresAt,
      expiresInSeconds: config.PAIRING_CODE_TTL_SECONDS,
      panelUrl: `/panel/${number}`,
    })
  } catch (e) {
    jsonError(res, 500, 'تعذر إصدار كود الاقتران حالياً.', { detail: e.message })
  }
})

app.post('/api/public/media-download', (req, res) => {
  const url = String(req.body?.url || '').trim()
  if (!/^https?:\/\//i.test(url)) {
    jsonError(res, 400, 'أدخل رابطاً صحيحاً يبدأ بـ http أو https.')
    return
  }
  let platform = 'Media'
  try {
    const host = new URL(url).hostname.toLowerCase()
    if (host.includes('tiktok')) platform = 'TikTok'
    else if (host.includes('instagram')) platform = 'Instagram'
    else platform = host
  } catch {}
  jsonOk(res, {
    platform,
    title: `Direct link from ${platform}`,
    downloadUrl: url,
  })
})

app.post('/api/panel/login', (req, res) => {
  const number = validateNumberInput(req.body?.number, res)
  if (!number) return
  const password = String(req.body?.password || '')
  if (!password) {
    jsonError(res, 400, 'كلمة المرور مطلوبة.')
    return
  }
  const found = db.getNumberWithOwner(number)
  if (!found) {
    jsonError(res, 404, 'هذا الرقم غير مربوط داخل النظام بعد.')
    return
  }
  if (!db.verifyPanelPassword(number, password)) {
    jsonError(res, 401, 'كلمة المرور غير صحيحة.')
    return
  }
  const issued = db.issuePanelToken(number)
  jsonOk(res, { number, token: issued.token, expiresAt: issued.expiresAt })
})

app.post('/api/panel/logout', (req, res) => {
  const token = String(req.headers['x-panel-token'] || '')
  if (token) db.revokePanelTokenByToken(token)
  jsonOk(res, { loggedOut: true })
})

app.get('/api/panel/:number/default-password', (req, res) => {
  const number = validateNumberInput(req.params.number, res)
  if (!number) return
  const found = db.getNumberWithOwner(number)
  if (!found) {
    jsonError(res, 404, 'الرقم غير موجود.')
    return
  }
  jsonOk(res, {
    number,
    defaultPassword: db.getDefaultPassword(number),
    hasCustomPassword: db.hasCustomPassword(number),
  })
})

app.get('/api/panel/:number/settings', authenticatePanel, (req, res) => {
  const payload = buildPanelPayload(req.panelNumber)
  jsonOk(res, payload)
})

app.post('/api/panel/:number/settings', authenticatePanel, async (req, res) => {
  try {
    const settings = db.setSettingsByNumber(req.panelNumber, req.body?.settings || {})
    const emojis = settings.statusCustomReact || db.getReactionEmojiText(req.panelOwner.userId, req.panelNumber)
    whatsapp.applyLiveSettings(req.panelNumber)
    await notifyLinkedNumber(
      req.panelNumber,
      `✅ تم تحديث إعدادات الرقم من لوحة الموقع بنجاح.\n😀 إيموجيات التفاعل الحالية: ${emojis}`
    )
    jsonOk(res, { number: req.panelNumber, settings })
  } catch (e) {
    jsonError(res, 500, 'تعذر حفظ الإعدادات.', { detail: e.message })
  }
})

app.get('/api/panel/:number/wallet', authenticatePanel, (req, res) => {
  jsonOk(res, { wallet: db.getWallet(req.panelNumber), store: db.getStoreOffers(req.panelNumber) })
})

app.get('/api/panel/:number/status-reactions', authenticatePanel, (req, res) => {
  jsonOk(res, { reactions: db.getStatusReactions(req.panelNumber) })
})

app.post('/api/panel/:number/pair', authenticatePanel, async (req, res) => {
  const target = validateNumberInput(req.body?.number, res)
  if (!target) return

  try {
    const currentOwner = req.panelOwner
    ensureNumberExists(target, currentOwner.userId, currentOwner.user.chatId)
    const pairing = await whatsapp.generatePairingCode(target)
    jsonOk(res, {
      number: target,
      code: pairing.code,
      rawCode: pairing.rawCode,
      expiresAt: pairing.expiresAt,
      panelUrl: `/panel/${target}`,
    })
  } catch (e) {
    jsonError(res, 500, 'تعذر إصدار كود الاقتران.', { detail: e.message })
  }
})

app.post('/api/panel/:number/password', authenticatePanel, (req, res) => {
  const currentPassword = String(req.body?.currentPassword || '')
  const newPassword = String(req.body?.newPassword || '')
  if (!db.verifyPanelPassword(req.panelNumber, currentPassword)) {
    jsonError(res, 401, 'كلمة المرور الحالية غير صحيحة.')
    return
  }
  if (newPassword.length < 4) {
    jsonError(res, 400, 'كلمة المرور الجديدة يجب أن تكون 4 أحرف على الأقل.')
    return
  }
  db.setPanelPassword(req.panelNumber, newPassword)
  jsonOk(res, { updated: true })
})

app.post('/api/panel/:number/claim-daily', authenticatePanel, async (req, res) => {
  try {
    const result = db.claimDaily(req.panelNumber)
    const notificationSent = await notifyLinkedNumber(
      req.panelNumber,
      `🎁 تم إضافة ${result.amount} عملة إلى محفظة الرقم من لوحة الموقع.`
    )
    jsonOk(res, { amount: result.amount, wallet: result.wallet, notificationSent })
  } catch (e) {
    if (e.message === 'too_early') {
      jsonError(res, 400, 'لا يمكنك استلام المكافأة الآن.', { remainingMs: e.remainingMs || 0 })
      return
    }
    jsonError(res, 500, 'تعذر استلام المكافأة اليومية.')
  }
})

app.post('/api/panel/:number/store/buy', authenticatePanel, async (req, res) => {
  try {
    const result = db.buyOffer(req.panelNumber, String(req.body?.offerKey || ''))
    const notificationSent = await notifyLinkedNumber(
      req.panelNumber,
      `🛍 تم شراء الميزة ${result.offer.title} بنجاح من لوحة الموقع.`
    )
    jsonOk(res, { result, notificationSent })
  } catch (e) {
    const messageMap = {
      offer_not_found: 'العرض المطلوب غير موجود.',
      insufficient_balance: 'رصيد المحفظة غير كافٍ.',
    }
    jsonError(res, 400, messageMap[e.message] || 'تعذر تنفيذ عملية الشراء.')
  }
})

app.post('/api/admin/login', (req, res) => {
  const token = String(req.body?.token || '')
  if (token !== config.ADMIN_PANEL_TOKEN) {
    jsonError(res, 401, 'توكن الإدارة غير صحيح.')
    return
  }
  jsonOk(res, { authenticated: true })
})

app.get('/api/admin/comments', authenticateAdmin, (req, res) => {
  jsonOk(res, { comments: db.listComments() })
})

app.post('/api/admin/comments/:id/reply', authenticateAdmin, (req, res) => {
  const reply = String(req.body?.reply || '').trim()
  const by = String(req.body?.by || 'المطور').trim() || 'المطور'
  if (!reply) {
    jsonError(res, 400, 'نص الرد مطلوب.')
    return
  }
  try {
    const comment = db.replyComment(req.params.id, reply, by)
    jsonOk(res, { comment })
  } catch (e) {
    jsonError(res, 404, 'التعليق غير موجود.')
  }
})

for (const [routePath, fileName] of Object.entries(HTML_PAGES)) {
  app.get(routePath, (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, fileName))
  })
}

app.get('/panel/:number', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'panel.html'))
})

app.use((req, res) => {
  res.status(404).sendFile(path.join(PUBLIC_DIR, 'index.html'))
})

async function bootstrap() {
  installTelegramBot()
  await whatsapp.resumeAll()
  whatsapp.startHealthMonitor()

  app.listen(config.PORT, () => {
    console.log(`🌐 Web panel running on port ${config.PORT}`)
  })
}

bootstrap().catch((e) => {
  console.error('[bootstrap]', e)
  process.exit(1)
})

process.on('uncaughtException', (e) => console.error('[uncaughtException]', e.message))
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e?.message || e))