/**
 * بوت تيليجرام لربط أرقام واتساب والتفاعل التلقائي مع الحالات
 * -----------------------------------------------------------
 * المتطلبات:
 * - توكن بوت تيليجرام من @BotFather داخل ملف .env
 * - كل رقم يعمل في جلسة واتساب مستقلة بإيموجي تفاعل خاص به
 */
const TelegramBot = require('node-telegram-bot-api')
const emojiRegex = require('emoji-regex')
const config = require('./config')
const db = require('./db')
const whatsapp = require('./whatsapp')

// تحميل قاعدة البيانات أولاً
db.load()

if (!config.TELEGRAM_TOKEN) {
  console.error('❌ TELEGRAM_TOKEN غير موجود!')
  console.error('انسخ ملف .env.example إلى .env وضع فيه توكن البوت من @BotFather')
  process.exit(1)
}

const bot = new TelegramBot(config.TELEGRAM_TOKEN, { polling: true })

/* حالة انتظار إدخال من المستخدم: chatId -> { action, userId, number? } */
const pending = new Map()

function isAuthorized(userId) {
  if (!config.ONLY_ADMINS) return true
  return config.ADMIN_IDS.includes(userId)
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function statusText(s) {
  const map = {
    new: '🆕 جديد',
    pairing: '🔗 بانتظار كود الاقتران',
    connecting: '🔄 جاري تسجيل الدخول',
    connected: '🟢 متصل',
    logged_out: '🔴 مسجل خروجه',
  }
  return map[s] || escapeHtml(s)
}

function mainMenuKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '😀 تغيير إيموجي التفاعل', callback_data: 'emoji_start' }],
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
          (n, i) =>
            `${i + 1}. 📱 <b>${escapeHtml(n.number)}</b>\n` +
            `   😀 إيموجي التفاعل: <b>${escapeHtml(n.emoji || '❤️')}</b>\n` +
            `   📶 الحالة: ${statusText(n.status)}`
        )
        .join('\n\n')
    : '— لا توجد أرقام مربوطة حالياً.'

  return (
    `👋 أهلًا بك في بوت التفاعل مع الحالات!\n\n` +
    `📌 <b>ماذا يفعل البوت:</b>\n` +
    `• تربط رقم واتساب عبر كود الاقتران من داخل البوت مباشرة\n` +
    `• يتفاعل البوت تلقائياً وبشكل مستمر على حالات (ستوريات) جهات اتصالك\n` +
    `• كل رقم له جلسة مستقلة وإيموجي تفاعل خاص به لا يتأثر بغيره\n\n` +
    `📋 <b>الأرقام الحالية:</b>\n${lines}\n\n` +
    `ℹ️ عند تغيير الإيموجي أو تغير حالة الاتصال سيتم تحديث هذه الرسالة تلقائياً.`
  )
}

async function showDashboard(chatId, userId, options = {}) {
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
      if (!String(e.message || '').includes('message is not modified')) {
        db.clearDashboardMessage(userId)
      }
      if (String(e.message || '').includes('message is not modified')) {
        return { message_id: messageId, edited: true }
      }
    }
  }

  const sent = await bot.sendMessage(chatId, text, payload)
  db.setDashboardMessage(userId, sent.message_id)
  return sent
}

async function refreshDashboardByChat(chatId) {
  const user = db.getUserByChatId(chatId)
  if (!user) return
  try {
    await showDashboard(chatId, user.userId)
  } catch (e) {
    console.error('[تحديث الواجهة]', e.message)
  }
}

/* إرسال إشعارات الجلسات إلى تيليجرام */
whatsapp.setNotifier(async (chatId, text) => {
  try {
    await bot.sendMessage(chatId, text, { parse_mode: 'HTML' })
  } catch (e) {
    console.error('[إشعار]', e.message)
  }
  await refreshDashboardByChat(chatId)
})

/* ربط رقم جديد: تحقق + حفظ + بدء الجلسة وإرسال كود الاقتران */
async function linkNumber(chatId, userId, rawNumber) {
  const number = String(rawNumber || '').replace(/\D/g, '')
  if (!/^\d{8,15}$/.test(number)) {
    return bot
      .sendMessage(
        chatId,
        '❌ صيغة الرقم غير صحيحة.\nأرسل الرقم بالصيغة الدولية بدون + وبدون مسافات (مثال: 9665XXXXXXXX)'
      )
      .catch(() => {})
  }
  try {
    db.addNumber(userId, number, chatId)
  } catch (e) {
    if (e.message === 'already_linked')
      return bot.sendMessage(chatId, '⚠️ هذا الرقم مربوط بحسابك بالفعل.').catch(() => {})
    if (e.message === 'linked_other')
      return bot
        .sendMessage(
          chatId,
          '⚠️ هذا الرقم مربوط بجلسة مستخدم آخر.\nكل رقم يعمل في جلسة مستقلة ويمكن ربطه مرة واحدة فقط.'
        )
        .catch(() => {})
    throw e
  }

  await showDashboard(chatId, userId).catch(() => {})

  await bot
    .sendMessage(
      chatId,
      `⏳ جاري تجهيز كود الاقتران للرقم <b>${escapeHtml(number)}</b>...\nسيصلك الكود خلال لحظات.`,
      { parse_mode: 'HTML' }
    )
    .catch(() => {})

  whatsapp.startSession(userId, number, chatId).catch((e) => {
    console.error('[بدء الجلسة]', e.message)
    bot.sendMessage(chatId, '❌ تعذر بدء الجلسة: ' + e.message).catch(() => {})
  })
}

/* ---------- الأوامر ---------- */
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id
  const userId = msg.from.id
  if (!isAuthorized(userId))
    return bot.sendMessage(chatId, '⛔ أنت غير مصرح لك باستخدام هذا البوت.').catch(() => {})
  db.ensureUser(userId, chatId)
  await showDashboard(chatId, userId, { forceNew: true }).catch(() => {})
})

/* ---------- الأزرار (Callback Queries) ---------- */
bot.on('callback_query', async (q) => {
  const chatId = q.message?.chat?.id
  const userId = q.from.id
  const data = q.data || ''
  if (!chatId) return
  if (!isAuthorized(userId)) {
    return bot.answerCallbackQuery(q.id, { text: '⛔ غير مصرح' }).catch(() => {})
  }

  try {
    if (data === 'emoji_start') {
      bot.answerCallbackQuery(q.id).catch(() => {})
      const numbers = db.getUser(userId)?.numbers || []
      if (!numbers.length) {
        return bot
          .sendMessage(chatId, '⚠️ لا يوجد لديك أرقام مربوطة بعد.\nاضغط «➕ ربط رقم جديد» أولاً.')
          .catch(() => {})
      }
      const kb = numbers.map((n) => [
        {
          text: `📱 ${n.number}  ( ${n.emoji || '❤️'} )`,
          callback_data: `emoji:${n.number}`,
        },
      ])
      kb.push([{ text: '🔙 رجوع', callback_data: 'back' }])
      return bot
        .sendMessage(chatId, '👇 اختر الرقم الذي تريد تغيير إيموجي التفاعل الخاص به:', {
          reply_markup: { inline_keyboard: kb },
        })
        .catch(() => {})
    }

    if (data.startsWith('emoji:')) {
      const number = data.slice(6)
      pending.set(chatId, { action: 'set_emoji', userId, number })
      return bot
        .sendMessage(
          chatId,
          `✍️ أرسل الآن الإيموجي الذي تريد التفاعل به على الحالات للرقم <b>${escapeHtml(number)}</b>\n\n(إيموجي واحد فقط - مثال: ❤️ 🔥 👍 😂 😮)`,
          { parse_mode: 'HTML' }
        )
        .catch(() => {})
    }

    if (data === 'link') {
      pending.set(chatId, { action: 'add_number', userId })
      return bot
        .sendMessage(
          chatId,
          `📲 أرسل رقم واتساب بالصيغة الدولية <b>بدون</b> + أو أصفار بادئة وبدون مسافات.\n\n` +
            `<code>مثال: 9665XXXXXXXX</code>\n\n⚠️ الرقم يجب ألا يكون مربوطاً بجلسة أخرى.`,
          { parse_mode: 'HTML' }
        )
        .catch(() => {})
    }

    if (data === 'list') {
      const numbers = db.getUser(userId)?.numbers || []
      if (!numbers.length) {
        return bot.sendMessage(chatId, '⚠️ لا توجد أرقام مربوطة.').catch(() => {})
      }
      const lines = numbers.map(
        (n, i) =>
          `${i + 1}. 📱 <b>${escapeHtml(n.number)}</b>\n` +
          `   😀 الإيموجي: <b>${escapeHtml(n.emoji || '❤️')}</b> | الحالة: ${statusText(n.status)}`
      )
      return bot
        .sendMessage(chatId, `📋 أرقامك المربوطة (${numbers.length}):\n\n${lines.join('\n\n')}`, {
          parse_mode: 'HTML',
        })
        .catch(() => {})
    }

    if (data === 'del_list') {
      const numbers = db.getUser(userId)?.numbers || []
      if (!numbers.length) {
        return bot.sendMessage(chatId, '⚠️ لا توجد أرقام لحذفها.').catch(() => {})
      }
      const kb = numbers.map((n) => [
        { text: `🗑 ${n.number}`, callback_data: `del:${n.number}` },
      ])
      kb.push([{ text: '🔙 رجوع', callback_data: 'back' }])
      return bot
        .sendMessage(chatId, 'اختر الرقم لحذفه (سيتم تسجيل الخروج من واتساب):', {
          reply_markup: { inline_keyboard: kb },
        })
        .catch(() => {})
    }

    if (data.startsWith('del:')) {
      const number = data.slice(4)
      return bot
        .sendMessage(
          chatId,
          `⚠️ هل أنت متأكد من حذف الرقم <b>${escapeHtml(number)}</b>؟\nسيتم تسجيل الخروج من واتساب وحذف بيانات الجلسة نهائياً.`,
          {
            parse_mode: 'HTML',
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
        .catch(() => {})
    }

    if (data.startsWith('confirm_del:')) {
      const number = data.slice(12)
      await whatsapp.stopSession(userId, number, true)
      db.removeNumber(userId, number)
      await bot
        .sendMessage(chatId, `🗑 تم حذف الرقم <b>${escapeHtml(number)}</b> وتسجيل الخروج من واتساب.`, {
          parse_mode: 'HTML',
        })
        .catch(() => {})
      await showDashboard(chatId, userId).catch(() => {})
      return
    }

    if (data === 'back') {
      await showDashboard(chatId, userId, { messageId: q.message.message_id }).catch(() => {})
      return
    }
  } catch (e) {
    console.error('[زر]', e.message)
  }
})

/* ---------- الرسائل النصية (إدخال الرقم / الإيموجي) ---------- */
bot.on('message', async (msg) => {
  const chatId = msg.chat.id
  const userId = msg.from.id
  if (!isAuthorized(userId) || !msg.text) return

  if (msg.text.startsWith('/')) {
    const parts = msg.text.split(/\s+/)
    if (parts[0] === '/add') {
      const num = (parts[1] || '').replace(/\D/g, '')
      if (!num) return bot.sendMessage(chatId, 'الاستخدام: /add 9665XXXXXXXX').catch(() => {})
      return linkNumber(chatId, userId, num)
    }
    if (parts[0] === '/remove') {
      const num = (parts[1] || '').replace(/\D/g, '')
      if (!num) return bot.sendMessage(chatId, 'الاستخدام: /remove 9665XXXXXXXX').catch(() => {})
      const owned = db.getUser(userId)?.numbers?.some((n) => n.number === num)
      if (!owned)
        return bot.sendMessage(chatId, '⚠️ هذا الرقم غير مربوط بحسابك.').catch(() => {})
      await whatsapp.stopSession(userId, num, true)
      db.removeNumber(userId, num)
      await bot.sendMessage(chatId, `🗑 تم حذف الرقم ${escapeHtml(num)}.`).catch(() => {})
      await showDashboard(chatId, userId).catch(() => {})
      return
    }
    return
  }

  const p = pending.get(chatId)
  if (!p) return

  if (p.action === 'add_number') {
    pending.delete(chatId)
    return linkNumber(chatId, userId, msg.text)
  }

  if (p.action === 'set_emoji') {
    pending.delete(chatId)
    const m = msg.text.match(emojiRegex())
    if (!m) {
      return bot
        .sendMessage(
          chatId,
          '❌ لم أجد إيموجي في رسالتك.\nأرسل إيموجي واحد فقط (مثال: ❤️ 🔥 👍 😂 😮).'
        )
        .catch(() => {})
    }
    try {
      const emoji = m[0]
      db.setEmoji(p.userId, p.number, emoji)
      await bot
        .sendMessage(
          chatId,
          `✅ تم حفظ الإيموجي <b>${escapeHtml(emoji)}</b> للرقم <b>${escapeHtml(p.number)}</b>.\n\n` +
            `🟢 تم تطبيقه فوراً على هذا الرقم، وتم تحديث رسالة /start تلقائياً.`,
          { parse_mode: 'HTML' }
        )
        .catch(() => {})
      await showDashboard(chatId, p.userId).catch(() => {})
    } catch (e) {
      await bot.sendMessage(chatId, '❌ الرقم غير موجود في حسابك.').catch(() => {})
    }
  }
})

/* ---------- الإقلاع ---------- */
whatsapp.resumeAll()
console.log('🤖 بوت التفاعل يعمل... (اضغط Ctrl+C للإيقاف)')

/* منع تعطل البوت عند أي خطأ غير متوقع */
process.on('uncaughtException', (e) => console.error('[خطأ عام]', e.message))
process.on('unhandledRejection', (e) => console.error('[خطأ وعد]', e?.message || e))
