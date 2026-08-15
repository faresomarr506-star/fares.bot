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
const verifiedSettingsAccess = new Map()
let bot = null

const SETTINGS_ACCESS_TTL_MS = 30 * 60 * 1000

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

const SETTINGS_CATEGORIES = [
  { id: 'overview', label: '📋 كل الإعدادات' },
  { id: 'general', label: '🧩 عام' },
  { id: 'automation', label: '🤖 تلقائي' },
  { id: 'status', label: '📲 الحالات' },
  { id: 'protection', label: '🛡️ الحماية' },
  { id: 'schedule', label: '⏰ الجدولة' },
]

const SETTINGS_SCHEMA = [
  { key: 'name', label: 'اسم البوت', category: 'general', type: 'text' },
  { key: 'ownername', label: 'اسم المالك', category: 'general', type: 'text' },
  { key: 'description', label: 'الوصف', category: 'general', type: 'textarea' },
  { key: 'from', label: 'الدولة', category: 'general', type: 'text' },
  { key: 'age', label: 'العمر', category: 'general', type: 'number' },
  { key: 'prefix', label: 'البادئة', category: 'general', type: 'text' },
  { key: 'footer2', label: 'الفوتر', category: 'general', type: 'text' },
  {
    key: 'mode',
    label: 'وضع التشغيل',
    category: 'general',
    type: 'enum',
    options: [
      { value: 'private', label: 'private' },
      { value: 'public', label: 'public' },
      { value: 'group', label: 'group' },
    ],
  },
  {
    key: 'language',
    label: 'اللغة',
    category: 'general',
    type: 'enum',
    options: [
      { value: 'arabic', label: 'arabic' },
      { value: 'english', label: 'english' },
    ],
  },
  { key: 'menu', label: 'نص قائمة menu', category: 'general', type: 'textarea' },
  { key: 'alive', label: 'نص alive', category: 'general', type: 'textarea' },
  { key: 'owner', label: 'نص owner', category: 'general', type: 'textarea' },

  { key: 'alwaysOnline', label: 'دائم الاتصال', category: 'automation', type: 'boolean' },
  { key: 'autoTyping', label: 'كتابة تلقائية', category: 'automation', type: 'boolean' },
  { key: 'autoRecording', label: 'تسجيل تلقائي', category: 'automation', type: 'boolean' },
  { key: 'autoRead', label: 'قراءة تلقائية', category: 'automation', type: 'boolean' },
  { key: 'autoReact', label: 'رد فعل تلقائي', category: 'automation', type: 'boolean' },
  { key: 'autoPrivateReact', label: 'تفاعل الخاص', category: 'automation', type: 'boolean' },
  { key: 'autoVoice', label: 'صوت تلقائي', category: 'automation', type: 'boolean' },
  { key: 'autoBlock', label: 'حظر تلقائي', category: 'automation', type: 'boolean' },
  { key: 'autoSave', label: 'حفظ تلقائي', category: 'automation', type: 'boolean' },
  { key: 'ghostMode', label: 'وضع الشبح', category: 'automation', type: 'boolean' },
  {
    key: 'aiReplyScope',
    label: 'نطاق رد الذكاء',
    category: 'automation',
    type: 'enum',
    options: [
      { value: 'inbox', label: 'inbox' },
      { value: 'group', label: 'group' },
      { value: 'both', label: 'both' },
    ],
  },
  {
    key: 'autoReactScope',
    label: 'نطاق التفاعل',
    category: 'automation',
    type: 'enum',
    options: [
      { value: 'inbox', label: 'inbox' },
      { value: 'group', label: 'group' },
      { value: 'both', label: 'both' },
    ],
  },
  { key: 'customAutoReplies', label: 'ردود تلقائية مخصصة', category: 'automation', type: 'textarea' },
  { key: 'aliveMsg', label: 'رسالة alive', category: 'automation', type: 'textarea' },
  { key: 'voiceFooter', label: 'فوتر الصوت', category: 'automation', type: 'text' },

  { key: 'autoStatusRead', label: 'مشاهدة الحالات', category: 'status', type: 'boolean' },
  { key: 'autoStatusReact', label: 'التفاعل مع الحالات', category: 'status', type: 'boolean' },
  { key: 'statusReactionNotice', label: 'تنبيه التفاعل', category: 'status', type: 'boolean' },
  { key: 'statusViewBoost', label: 'تعزيز الحالات', category: 'status', type: 'boolean' },
  { key: 'statusMsgSend', label: 'إرسال رسالة حالة', category: 'status', type: 'boolean' },
  {
    key: 'statusMsgType',
    label: 'نوع رسالة الحالة',
    category: 'status',
    type: 'enum',
    options: [
      { value: 'default', label: 'default' },
      { value: 'custom', label: 'custom' },
    ],
  },
  { key: 'customMsg', label: 'رسالة الحالة المخصصة', category: 'status', type: 'textarea' },
  { key: 'statusCustomReact', label: 'إيموجيات الحالات', category: 'status', type: 'emoji' },

  { key: 'antiBad', label: 'منع السيء', category: 'protection', type: 'boolean' },
  { key: 'antiLink', label: 'منع الروابط', category: 'protection', type: 'boolean' },
  { key: 'antiSpam', label: 'منع السبام', category: 'protection', type: 'boolean' },
  { key: 'antiGroupAdd', label: 'منع الإضافة للجروبات', category: 'protection', type: 'boolean' },
  { key: 'antiPrivateMessages', label: 'منع الخاص', category: 'protection', type: 'boolean' },
  { key: 'antiViewOnce', label: 'فتح العرض مرة', category: 'protection', type: 'boolean' },
  { key: 'antiCall', label: 'منع الاتصالات', category: 'protection', type: 'boolean' },
  { key: 'excludeCallNumbers', label: 'استثناء أرقام الاتصال', category: 'protection', type: 'textarea' },
  { key: 'antiDelete', label: 'منع الحذف', category: 'protection', type: 'boolean' },
  { key: 'antiDeleteMessages', label: 'منع حذف الرسائل', category: 'protection', type: 'boolean' },
  { key: 'saveDeletedMessageMedia', label: 'حفظ وسائط المحذوف', category: 'protection', type: 'boolean' },
  {
    key: 'sendDeleteTo',
    label: 'إرسال المحذوف إلى',
    category: 'protection',
    type: 'enum',
    options: [
      { value: 'owner', label: 'owner' },
      { value: 'group', label: 'group' },
      { value: 'both', label: 'both' },
    ],
  },
  { key: 'keepDeletedStatus', label: 'حفظ الحالات المحذوفة', category: 'protection', type: 'boolean' },
  { key: 'saveDeletedStatusMedia', label: 'حفظ وسائط الحالة المحذوفة', category: 'protection', type: 'boolean' },
  { key: 'deletedStatusArchiveSize', label: 'أرشيف الحالات المحذوفة', category: 'protection', type: 'number' },
  { key: 'deletedMessageArchiveSize', label: 'أرشيف الرسائل المحذوفة', category: 'protection', type: 'number' },
  { key: 'antiBug', label: 'منع البق', category: 'protection', type: 'boolean' },
  { key: 'antiBot', label: 'منع البوتات', category: 'protection', type: 'boolean' },
  {
    key: 'antiBotAction',
    label: 'إجراء منع البوت',
    category: 'protection',
    type: 'enum',
    options: [
      { value: 'delete', label: 'delete' },
      { value: 'warn', label: 'warn' },
      { value: 'block', label: 'block' },
    ],
  },
  { key: 'antiBadWords', label: 'كلمات المنع', category: 'protection', type: 'textarea' },
  { key: 'antiLinkList', label: 'قائمة الروابط الممنوعة', category: 'protection', type: 'textarea' },
  { key: 'antiMention', label: 'منع المنشن', category: 'protection', type: 'boolean' },
  { key: 'antiEdit', label: 'منع التعديل', category: 'protection', type: 'boolean' },
  {
    key: 'antiAction',
    label: 'إجراء الحماية',
    category: 'protection',
    type: 'enum',
    options: [
      { value: 'warn', label: 'warn' },
      { value: 'delete', label: 'delete' },
      { value: 'block', label: 'block' },
    ],
  },
  { key: 'antiWarnCount', label: 'عدد التحذيرات', category: 'protection', type: 'number' },

  { key: 'gaGroupJid', label: 'معرف مجموعة الجدولة', category: 'schedule', type: 'text' },
  { key: 'gaTimezone', label: 'المنطقة الزمنية', category: 'schedule', type: 'text' },
  { key: 'gaCloseTime', label: 'وقت الإغلاق', category: 'schedule', type: 'time' },
  { key: 'gaOpenTime', label: 'وقت الفتح', category: 'schedule', type: 'time' },
]

const SETTINGS_MAP = new Map(SETTINGS_SCHEMA.map((item) => [item.key, item]))

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
        [
          { text: '🔐 تغيير كلمة المرور', callback_data: 'password_menu' },
          { text: '⚙️ إعدادات الرقم', callback_data: 'number_settings_menu' },
        ],
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
            `   📶 الحالة: ${statusText(item.status)}\n` +
            `   🔐 كلمة المرور: <b>${item.panelPasswordHash ? 'مخصصة' : 'الافتراضية = نفس الرقم'}</b>`
        )
        .join('\n\n')
    : '— لا توجد أرقام مربوطة حالياً.'

  return (
    `👋 أهلاً بك في منصة ربط واتساب والتفاعل مع الحالات!\n\n` +
    `📌 <b>ما الذي يفعله البوت:</b>\n` +
    `• ربط رقم واتساب عبر كود الاقتران مباشرة\n` +
    `• حفظ الجلسات بشكل دائم والعودة التلقائية بعد إعادة التشغيل\n` +
    `• مشاهدة الحالات والتفاعل عليها بشكل مستمر لكل رقم مربوط\n` +
    `• دعم أكثر من إيموجي للتفاعل لكل رقم\n` +
    `• تغيير كلمة مرور كل رقم وفتح إعداداته من داخل تيليجرام\n\n` +
    `📋 <b>الأرقام الحالية:</b>\n${lines}\n\n` +
    `💡 <b>أوامر سريعة:</b> /add /remove /password /settings /cancel\n` +
    `🌐 لوحة الموقع والإعدادات مرتبطة بنفس قاعدة البوت، وأي تغيير من تيليجرام أو الموقع يُطبق مباشرة على الرقم.`
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

async function safeAnswerCallback(query, text = '') {
  if (!bot || !query?.id) return
  try {
    await bot.answerCallbackQuery(query.id, text ? { text } : {})
  } catch {}
}

function chunkRows(items, perRow = 2) {
  const rows = []
  for (let i = 0; i < items.length; i += perRow) rows.push(items.slice(i, i + perRow))
  return rows
}

function truncateText(value, max = 18) {
  const text = String(value || '')
  if (text.length <= max) return text
  return text.slice(0, Math.max(1, max - 1)) + '…'
}

function getUserNumbers(userId) {
  return db.getUser(userId)?.numbers || []
}

function userOwnsNumber(userId, number) {
  return getUserNumbers(userId).some((item) => item.number === normalizeNumber(number))
}

function clearPending(chatId) {
  pending.delete(chatId)
}

function setVerifiedSettingsAccess(chatId, userId, number) {
  verifiedSettingsAccess.set(String(chatId), {
    chatId: String(chatId),
    userId: String(userId),
    number: normalizeNumber(number),
    verifiedAt: Date.now(),
  })
}

function clearVerifiedSettingsAccess(chatId) {
  verifiedSettingsAccess.delete(String(chatId))
}

function hasVerifiedSettingsAccess(chatId, userId, number) {
  const session = verifiedSettingsAccess.get(String(chatId))
  if (!session) return false
  if (session.userId !== String(userId)) return false
  if (session.number !== normalizeNumber(number)) return false
  if (Date.now() - session.verifiedAt > SETTINGS_ACCESS_TTL_MS) {
    verifiedSettingsAccess.delete(String(chatId))
    return false
  }
  return true
}

function touchVerifiedSettingsAccess(chatId) {
  const key = String(chatId)
  const current = verifiedSettingsAccess.get(key)
  if (!current) return
  current.verifiedAt = Date.now()
  verifiedSettingsAccess.set(key, current)
}

function buildNumberPickerKeyboard(numbers, prefix, includeBack = true) {
  const rows = numbers.map((item) => [
    {
      text: `📱 ${item.number}`,
      callback_data: `${prefix}:${item.number}`,
    },
  ])
  if (includeBack) rows.push([{ text: '🔙 رجوع', callback_data: 'back' }])
  return { inline_keyboard: rows }
}

async function promptForNumberSelection(chatId, userId, prefix, title, emptyText) {
  const numbers = getUserNumbers(userId)
  if (!numbers.length) {
    await sendTelegramMessage(chatId, emptyText)
    return false
  }
  await sendTelegramMessage(chatId, title, {
    reply_markup: buildNumberPickerKeyboard(numbers, prefix),
  })
  return true
}

function settingMeta(key) {
  return SETTINGS_MAP.get(String(key || '')) || null
}

function categoryMeta(categoryId) {
  return SETTINGS_CATEGORIES.find((item) => item.id === categoryId) || SETTINGS_CATEGORIES[0]
}

function categorySettings(categoryId) {
  return SETTINGS_SCHEMA.filter((item) => item.category === categoryId)
}

function formatBooleanValue(value) {
  return String(value || '').toLowerCase() === 'on' ? 'تشغيل' : 'إيقاف'
}

function formatSettingValue(meta, value) {
  if (!meta) return escapeHtml(value)
  const raw = value == null ? '' : String(value)
  if (meta.type === 'boolean') return raw.toLowerCase() === 'on' ? '✅ تشغيل' : '❌ إيقاف'
  if (!raw) return '—'
  return escapeHtml(raw)
}

function buildSettingsOverviewText(number, settings) {
  const header = [
    `⚙️ <b>إعدادات الرقم ${escapeHtml(number)}</b>`,
    `🔐 تم التحقق من كلمة المرور بنجاح.`,
    `اختر أي قسم بالأسفل للتعديل، أو افتح <b>كل الإعدادات</b> لعرض الملخص الكامل.`,
  ]

  const sections = SETTINGS_CATEGORIES.filter((item) => item.id !== 'overview').map((category) => {
    const lines = categorySettings(category.id)
      .slice(0, 4)
      .map((meta) => `• <b>${escapeHtml(meta.label)}</b>: ${formatSettingValue(meta, settings?.[meta.key])}`)
      .join('\n')
    return `\n<b>${escapeHtml(category.label)}</b>\n${lines}`
  })

  return header.concat(sections).join('\n\n')
}

function buildCategorySettingsText(number, categoryId, settings) {
  const category = categoryMeta(categoryId)
  const metas = categorySettings(categoryId)
  const lines = metas.map(
    (meta) => `• <b>${escapeHtml(meta.label)}</b>: ${formatSettingValue(meta, settings?.[meta.key])}`
  )
  return (
    `⚙️ <b>إعدادات الرقم ${escapeHtml(number)}</b>\n` +
    `📂 القسم الحالي: <b>${escapeHtml(category.label)}</b>\n\n` +
    `${lines.join('\n') || '— لا توجد إعدادات في هذا القسم.'}\n\n` +
    `اضغط على أي زر بالأسفل لتعديله.`
  )
}

function buildSettingsKeyboard(number, categoryId = 'overview') {
  const categoryButtons = SETTINGS_CATEGORIES.map((item) => ({
    text: item.id === categoryId ? `• ${item.label}` : item.label,
    callback_data: item.id === 'overview' ? `cfgshow:${number}` : `cfgcat:${number}:${item.id}`,
  }))
  const rows = chunkRows(categoryButtons, 2)

  if (categoryId !== 'overview') {
    for (const meta of categorySettings(categoryId)) {
      rows.push([
        {
          text: `✏️ ${truncateText(meta.label, 24)}`,
          callback_data: `cfgedit:${number}:${meta.key}:${categoryId}`,
        },
      ])
    }
  }

  rows.push([{ text: '🔒 قفل الإعدادات', callback_data: `cfglock:${number}` }])
  rows.push([{ text: '🔙 القائمة الرئيسية', callback_data: 'back' }])
  return { inline_keyboard: rows }
}

async function showNumberSettings(chatId, userId, number, categoryId = 'overview', messageId = null) {
  const normalized = normalizeNumber(number)
  if (!userOwnsNumber(userId, normalized)) {
    await sendTelegramMessage(chatId, '⚠️ هذا الرقم غير مربوط بحسابك.')
    return null
  }
  if (!hasVerifiedSettingsAccess(chatId, userId, normalized)) {
    await sendTelegramMessage(chatId, '🔒 انتهت صلاحية فتح الإعدادات. ادخل كلمة المرور مرة أخرى من زر إعدادات الرقم.')
    return null
  }

  touchVerifiedSettingsAccess(chatId)
  const settings = db.getSettingsByNumber(normalized)
  const text =
    categoryId === 'overview'
      ? buildSettingsOverviewText(normalized, settings)
      : buildCategorySettingsText(normalized, categoryId, settings)

  const payload = {
    parse_mode: 'HTML',
    reply_markup: buildSettingsKeyboard(normalized, categoryId),
  }

  if (messageId) {
    try {
      return await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: messageId,
        ...payload,
      })
    } catch (e) {
      if (!String(e.message || '').includes('message is not modified')) {
        console.error('[show settings edit]', e.message)
      }
    }
  }

  return sendTelegramMessage(chatId, text, payload)
}

function normalizeTextInput(value) {
  return String(value || '').trim()
}

function isEmptySignal(value) {
  const normalized = normalizeTextInput(value).toLowerCase()
  return ['-', 'فارغ', 'مسح', 'clear', 'delete'].includes(normalized)
}

function parseSettingInput(meta, input) {
  const text = normalizeTextInput(input)
  if (!meta) throw new Error('invalid_setting')

  if (meta.type === 'boolean') {
    const normalized = text.toLowerCase()
    if (['on', 'تشغيل', '1', 'true'].includes(normalized)) return 'on'
    if (['off', 'إيقاف', '0', 'false'].includes(normalized)) return 'off'
    throw new Error('invalid_boolean')
  }

  if (meta.type === 'enum') {
    const normalized = text.toLowerCase()
    const option = (meta.options || []).find((item) => item.value.toLowerCase() === normalized)
    if (!option) throw new Error('invalid_enum')
    return option.value
  }

  if (meta.type === 'emoji') {
    const emojis = parseReactionEmojis(text)
    if (!emojis.length) throw new Error('invalid_emoji')
    return db.emojisText(emojis)
  }

  if (meta.type === 'number') {
    if (!/^\d+$/.test(text)) throw new Error('invalid_number')
    return text
  }

  if (meta.type === 'time') {
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(text)) throw new Error('invalid_time')
    return text
  }

  if (!text && !isEmptySignal(text)) throw new Error('required_value')
  if (isEmptySignal(text)) return ''
  return text
}

function settingInputHelp(meta) {
  if (!meta) return ''
  if (meta.type === 'emoji') return 'أرسل إيموجي واحد أو عدة إيموجيات مثل: ❤️ 🔥 😂'
  if (meta.type === 'number') return 'أرسل قيمة رقمية فقط.'
  if (meta.type === 'time') return 'أرسل الوقت بصيغة HH:MM مثال 15:00'
  if (meta.type === 'enum') {
    return `القيم المتاحة: ${(meta.options || []).map((item) => item.value).join(' / ')}`
  }
  if (meta.type === 'boolean') return 'أرسل on أو off'
  return 'أرسل القيمة الجديدة. لإفراغ الحقل أرسل -'
}

async function applySettingChange(chatId, userId, number, key, value, categoryId, messageId = null) {
  const meta = settingMeta(key)
  if (!meta) {
    await sendTelegramMessage(chatId, '❌ الإعداد المطلوب غير معروف.')
    return null
  }
  if (!userOwnsNumber(userId, number)) {
    await sendTelegramMessage(chatId, '⚠️ هذا الرقم غير مربوط بحسابك.')
    return null
  }
  if (!hasVerifiedSettingsAccess(chatId, userId, number)) {
    await sendTelegramMessage(chatId, '🔒 انتهت صلاحية الوصول للإعدادات. افتحها من جديد بكلمة المرور.')
    return null
  }

  db.setSettingsByNumber(number, { [key]: value })
  whatsapp.applyLiveSettings(number)
  await sendTelegramMessage(
    chatId,
    `✅ تم تحديث <b>${escapeHtml(meta.label)}</b> للرقم <b>${escapeHtml(number)}</b> إلى: <b>${formatSettingValue(meta, value)}</b>`
  )
  return showNumberSettings(chatId, userId, number, categoryId || meta.category || 'overview', messageId)
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
    const pairing = await whatsapp.generatePairingCode(number)
    await sendTelegramMessage(
      chatId,
      `🔗 <b>كود الاقتران</b> للرقم <b>${escapeHtml(number)}</b>:\n\n` +
        `<code>${escapeHtml(pairing.code)}</code>\n\n` +
        `📲 افتح واتساب ← الأجهزة المرتبطة ← الاقتران برقم ← أدخل الكود الآن.\n` +
        `⏳ الكود صالح لفترة قصيرة فقط.`
    )
  } catch (e) {
    console.error('[start session]', e.message)
    await sendTelegramMessage(
      chatId,
      '❌ تعذر إصدار كود الاقتران الآن. تم حفظ الرقم داخل حسابك ويمكنك إعادة المحاولة بعد لحظات.'
    )
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
    clearPending(chatId)
    clearVerifiedSettingsAccess(chatId)
    await showDashboard(chatId, userId, { forceNew: true }).catch(() => {})
  })

  bot.on('callback_query', async (query) => {
    const chatId = query.message?.chat?.id
    const userId = String(query.from.id)
    const data = query.data || ''
    if (!chatId) return
    if (!isAuthorized(userId)) {
      await safeAnswerCallback(query, '⛔ غير مصرح')
      return
    }

    db.ensureUser(userId, chatId)

    try {
      if (data === 'emoji_start') {
        await safeAnswerCallback(query)
        const numbers = getUserNumbers(userId)
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
        await safeAnswerCallback(query)
        const number = data.slice(6)
        if (!userOwnsNumber(userId, number)) {
          await sendTelegramMessage(chatId, '⚠️ هذا الرقم غير مربوط بحسابك.')
          return
        }
        pending.set(chatId, { action: 'set_emoji', userId, number })
        await sendTelegramMessage(
          chatId,
          `✍️ أرسل الآن <b>أكثر من إيموجي أو إيموجي واحد</b> للرقم <b>${escapeHtml(number)}</b>\n\n` +
            `مثال: ❤️ 🔥 😂 👍\n\n` +
            `للإلغاء أرسل /cancel`
        )
        return
      }

      if (data === 'link') {
        await safeAnswerCallback(query)
        pending.set(chatId, { action: 'add_number', userId })
        await sendTelegramMessage(
          chatId,
          `📲 أرسل رقم واتساب بالصيغة الدولية بدون + وبدون مسافات.\n\n<code>مثال: 9665XXXXXXXX</code>\n\nللإلغاء أرسل /cancel`
        )
        return
      }

      if (data === 'list') {
        await safeAnswerCallback(query)
        const numbers = getUserNumbers(userId)
        if (!numbers.length) {
          await sendTelegramMessage(chatId, '⚠️ لا توجد أرقام مربوطة.')
          return
        }
        const lines = numbers.map(
          (item, index) =>
            `${index + 1}. 📱 <b>${escapeHtml(item.number)}</b>\n` +
            `   😀 الإيموجيات: <b>${escapeHtml(reactionTextForRecord(item))}</b> | الحالة: ${statusText(item.status)}\n` +
            `   🔐 كلمة المرور: <b>${item.panelPasswordHash ? 'مخصصة' : 'الافتراضية = نفس الرقم'}</b>`
        )
        await sendTelegramMessage(chatId, `📋 أرقامك المربوطة (${numbers.length}):\n\n${lines.join('\n\n')}`)
        return
      }

      if (data === 'password_menu') {
        await safeAnswerCallback(query)
        await promptForNumberSelection(
          chatId,
          userId,
          'pwdnum',
          '🔐 اختر الرقم الذي تريد تغيير كلمة مروره:',
          '⚠️ لا توجد أرقام مربوطة لتغيير كلمة مرورها.'
        )
        return
      }

      if (data.startsWith('pwdnum:')) {
        await safeAnswerCallback(query)
        const number = data.slice(7)
        if (!userOwnsNumber(userId, number)) {
          await sendTelegramMessage(chatId, '⚠️ هذا الرقم غير مربوط بحسابك.')
          return
        }
        pending.set(chatId, { action: 'change_password', userId, number })
        await sendTelegramMessage(
          chatId,
          `🔐 أرسل الآن <b>كلمة المرور الجديدة</b> للرقم <b>${escapeHtml(number)}</b>.\n` +
            `يجب أن تكون 4 أحرف على الأقل.\n\nللإلغاء أرسل /cancel`
        )
        return
      }

      if (data === 'number_settings_menu') {
        await safeAnswerCallback(query)
        await promptForNumberSelection(
          chatId,
          userId,
          'cfgnum',
          '⚙️ اختر الرقم الذي تريد فتح إعداداته:',
          '⚠️ لا توجد أرقام مربوطة لفتح إعداداتها.'
        )
        return
      }

      if (data.startsWith('cfgnum:')) {
        await safeAnswerCallback(query)
        const number = data.slice(7)
        if (!userOwnsNumber(userId, number)) {
          await sendTelegramMessage(chatId, '⚠️ هذا الرقم غير مربوط بحسابك.')
          return
        }
        pending.set(chatId, { action: 'verify_number_settings', userId, number })
        await sendTelegramMessage(
          chatId,
          `🔐 أرسل كلمة المرور الخاصة بالرقم <b>${escapeHtml(number)}</b> لفتح الإعدادات.\n` +
            `إذا لم تكن غيّرتها من قبل فالكلمة الافتراضية هي نفس الرقم.\n\nللإلغاء أرسل /cancel`
        )
        return
      }

      if (data.startsWith('cfgshow:')) {
        await safeAnswerCallback(query)
        const number = data.slice(8)
        await showNumberSettings(chatId, userId, number, 'overview', query.message?.message_id)
        return
      }

      if (data.startsWith('cfgcat:')) {
        await safeAnswerCallback(query)
        const [, number, categoryId] = data.split(':')
        await showNumberSettings(chatId, userId, number, categoryId || 'overview', query.message?.message_id)
        return
      }

      if (data.startsWith('cfglock:')) {
        await safeAnswerCallback(query, 'تم قفل الإعدادات')
        const number = data.slice(8)
        if (hasVerifiedSettingsAccess(chatId, userId, number)) clearVerifiedSettingsAccess(chatId)
        await sendTelegramMessage(chatId, `🔒 تم قفل إعدادات الرقم <b>${escapeHtml(number)}</b>.`) 
        await showDashboard(chatId, userId).catch(() => {})
        return
      }

      if (data.startsWith('cfgedit:')) {
        await safeAnswerCallback(query)
        const [, number, key, categoryId] = data.split(':')
        const meta = settingMeta(key)
        if (!meta) {
          await sendTelegramMessage(chatId, '❌ هذا الإعداد غير معروف.')
          return
        }
        if (!hasVerifiedSettingsAccess(chatId, userId, number)) {
          await sendTelegramMessage(chatId, '🔒 انتهت صلاحية الوصول. افتح إعدادات الرقم بكلمة المرور مرة أخرى.')
          return
        }
        const settings = db.getSettingsByNumber(number) || {}

        if (meta.type === 'boolean') {
          const nextValue = String(settings[key] || '').toLowerCase() === 'on' ? 'off' : 'on'
          await applySettingChange(chatId, userId, number, key, nextValue, categoryId || meta.category, query.message?.message_id)
          return
        }

        if (meta.type === 'enum') {
          const buttons = (meta.options || []).map((item) => ({
            text: `${item.value === settings[key] ? '• ' : ''}${item.label}`,
            callback_data: `cfgopt:${number}:${key}:${item.value}:${categoryId || meta.category}`,
          }))
          const rows = chunkRows(buttons, 2)
          rows.push([{ text: '🔙 رجوع', callback_data: `cfgcat:${number}:${categoryId || meta.category}` }])
          await sendTelegramMessage(
            chatId,
            `⚙️ اختر القيمة الجديدة للحقل <b>${escapeHtml(meta.label)}</b> للرقم <b>${escapeHtml(number)}</b>:`,
            { reply_markup: { inline_keyboard: rows } }
          )
          return
        }

        pending.set(chatId, {
          action: 'edit_setting',
          userId,
          number,
          key,
          categoryId: categoryId || meta.category,
        })
        await sendTelegramMessage(
          chatId,
          `✍️ أرسل القيمة الجديدة للحقل <b>${escapeHtml(meta.label)}</b> للرقم <b>${escapeHtml(number)}</b>.\n` +
            `${escapeHtml(settingInputHelp(meta))}\n\n` +
            `للإلغاء أرسل /cancel`
        )
        return
      }

      if (data.startsWith('cfgopt:')) {
        await safeAnswerCallback(query)
        const [, number, key, value, categoryId] = data.split(':')
        await applySettingChange(chatId, userId, number, key, value, categoryId, query.message?.message_id)
        return
      }

      if (data === 'del_list') {
        await safeAnswerCallback(query)
        const numbers = getUserNumbers(userId)
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
        await safeAnswerCallback(query)
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
        await safeAnswerCallback(query)
        const number = data.slice(12)
        await whatsapp.stopSession(userId, number, true)
        db.removeNumber(userId, number)
        clearVerifiedSettingsAccess(chatId)
        await sendTelegramMessage(chatId, `🗑 تم حذف الرقم <b>${escapeHtml(number)}</b> بنجاح.`)
        await showDashboard(chatId, userId).catch(() => {})
        return
      }

      if (data === 'back') {
        await safeAnswerCallback(query)
        clearPending(chatId)
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

    db.ensureUser(userId, chatId)

    if (msg.text.startsWith('/')) {
      const parts = msg.text.split(/\s+/)
      if (parts[0] === '/start') return
      if (parts[0] === '/cancel') {
        clearPending(chatId)
        await sendTelegramMessage(chatId, '✅ تم إلغاء العملية الحالية.')
        await showDashboard(chatId, userId).catch(() => {})
        return
      }
      if (parts[0] === '/add') {
        const num = normalizeNumber(parts[1])
        if (!num) {
          await sendTelegramMessage(chatId, 'الاستخدام: /add 9665XXXXXXXX')
          return
        }
        clearPending(chatId)
        await linkNumber(chatId, userId, num)
        return
      }
      if (parts[0] === '/remove') {
        const num = normalizeNumber(parts[1])
        if (!num) {
          await sendTelegramMessage(chatId, 'الاستخدام: /remove 9665XXXXXXXX')
          return
        }
        const owned = userOwnsNumber(userId, num)
        if (!owned) {
          await sendTelegramMessage(chatId, '⚠️ هذا الرقم غير مربوط بحسابك.')
          return
        }
        await whatsapp.stopSession(userId, num, true)
        db.removeNumber(userId, num)
        clearVerifiedSettingsAccess(chatId)
        await sendTelegramMessage(chatId, `🗑 تم حذف الرقم <b>${escapeHtml(num)}</b>.`)
        await showDashboard(chatId, userId).catch(() => {})
        return
      }
      if (parts[0] === '/password') {
        clearPending(chatId)
        await promptForNumberSelection(
          chatId,
          userId,
          'pwdnum',
          '🔐 اختر الرقم الذي تريد تغيير كلمة مروره:',
          '⚠️ لا توجد أرقام مربوطة لتغيير كلمة مرورها.'
        )
        return
      }
      if (parts[0] === '/settings') {
        clearPending(chatId)
        await promptForNumberSelection(
          chatId,
          userId,
          'cfgnum',
          '⚙️ اختر الرقم الذي تريد فتح إعداداته:',
          '⚠️ لا توجد أرقام مربوطة لفتح إعداداتها.'
        )
        return
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
      return
    }

    if (state.action === 'change_password') {
      const newPassword = String(msg.text || '').trim()
      if (newPassword.length < 4) {
        await sendTelegramMessage(chatId, '❌ كلمة المرور يجب أن تكون 4 أحرف على الأقل. أرسل كلمة أخرى أو /cancel')
        return
      }
      pending.delete(chatId)
      try {
        db.setPanelPassword(state.number, newPassword)
        await sendTelegramMessage(
          chatId,
          `✅ تم تحديث كلمة مرور الرقم <b>${escapeHtml(state.number)}</b> بنجاح.\n` +
            `يمكنك الآن فتح إعداداته باستخدام كلمة المرور الجديدة.`
        )
        await showDashboard(chatId, state.userId).catch(() => {})
      } catch (e) {
        await sendTelegramMessage(chatId, '❌ تعذر تحديث كلمة المرور لهذا الرقم.')
      }
      return
    }

    if (state.action === 'verify_number_settings') {
      const password = String(msg.text || '')
      if (!db.verifyPanelPassword(state.number, password)) {
        await sendTelegramMessage(
          chatId,
          '❌ كلمة المرور غير صحيحة. حاول مرة أخرى، أو أرسل /cancel للإلغاء.'
        )
        return
      }
      pending.delete(chatId)
      setVerifiedSettingsAccess(chatId, state.userId, state.number)
      await showNumberSettings(chatId, state.userId, state.number, 'overview')
      return
    }

    if (state.action === 'edit_setting') {
      const meta = settingMeta(state.key)
      if (!meta) {
        pending.delete(chatId)
        await sendTelegramMessage(chatId, '❌ الإعداد المطلوب لم يعد متاحاً.')
        return
      }
      let value
      try {
        value = parseSettingInput(meta, msg.text)
      } catch (e) {
        const errorMap = {
          invalid_setting: 'الإعداد المطلوب غير صحيح.',
          invalid_boolean: 'القيمة غير صحيحة. أرسل on أو off.',
          invalid_enum: `القيمة غير صحيحة. ${(meta.options || []).map((item) => item.value).join(' / ')}`,
          invalid_emoji: 'أرسل إيموجي واحداً أو أكثر.',
          invalid_number: 'أرسل أرقاماً فقط.',
          invalid_time: 'أرسل الوقت بصيغة HH:MM مثل 15:00',
          required_value: 'أرسل قيمة غير فارغة، أو أرسل - لمسح الحقل.',
        }
        await sendTelegramMessage(chatId, `❌ ${errorMap[e.message] || 'تعذر فهم القيمة المرسلة.'}\nأرسل قيمة جديدة أو /cancel`)
        return
      }

      pending.delete(chatId)
      await applySettingChange(chatId, state.userId, state.number, state.key, value, state.categoryId)
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
