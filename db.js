/**
 * قاعدة بيانات بسيطة (JSON) لتخزين:
 * - أرقام كل مستخدم مع إعدادات التفاعل الخاصة بكل رقم
 * - chatId لكل مستخدم لإرسال الإشعارات
 * - تفعيل مشاهدة الحالات والتفاعل عليها تلقائياً بشكل افتراضي
 * - آخر رسالة لوحة تحكم /start لتحديثها تلقائياً
 */
const fs = require('fs')
const path = require('path')
const config = require('./config')

const DEFAULT_EMOJI = '❤️'
const file = config.DB_FILE
let data = { users: {} }

function normalizeNumber(raw) {
  return String(raw || '').replace(/\D/g, '')
}

function normalizeNumberRecord(record = {}) {
  return {
    number: normalizeNumber(record.number),
    emoji:
      typeof record.emoji === 'string' && record.emoji.trim().length
        ? record.emoji.trim()
        : DEFAULT_EMOJI,
    linkedAt: Number(record.linkedAt || Date.now()),
    status: record.status || 'new',
    autoViewStatus: record.autoViewStatus !== false,
    autoReactStatus: record.autoReactStatus !== false,
  }
}

function normalizeUserRecord(userId, user = {}) {
  return {
    userId: Number(user.userId || userId),
    chatId: user.chatId || null,
    dashboardMessageId: Number(user.dashboardMessageId || 0) || null,
    numbers: Array.isArray(user.numbers)
      ? user.numbers.map((item) => normalizeNumberRecord(item)).filter((item) => item.number)
      : [],
  }
}

function load() {
  try {
    if (fs.existsSync(file)) {
      data = JSON.parse(fs.readFileSync(file, 'utf8'))
    }
  } catch (e) {
    console.error('⚠️ خطأ في قراءة قاعدة البيانات:', e.message)
    data = { users: {} }
  }

  if (!data || typeof data !== 'object') data = { users: {} }
  if (!data.users || typeof data.users !== 'object') data.users = {}

  for (const [userId, user] of Object.entries(data.users)) {
    data.users[userId] = normalizeUserRecord(userId, user)
  }

  save()
}

function save() {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
    fs.renameSync(tmp, file)
  } catch (e) {
    console.error('⚠️ خطأ في حفظ قاعدة البيانات:', e.message)
  }
}

function ensureUser(userId, chatId) {
  if (!data.users[userId]) {
    data.users[userId] = normalizeUserRecord(userId, { userId, chatId: chatId || null, numbers: [] })
    save()
  } else if (chatId && data.users[userId].chatId !== chatId) {
    data.users[userId].chatId = chatId
    save()
  }
  return data.users[userId]
}

function getUser(userId) {
  return data.users[userId] || null
}

function getUserByChatId(chatId) {
  for (const user of Object.values(data.users)) {
    if (user.chatId === chatId) return user
  }
  return null
}

function setDashboardMessage(userId, messageId) {
  const user = ensureUser(userId)
  user.dashboardMessageId = Number(messageId || 0) || null
  save()
  return user.dashboardMessageId
}

function getDashboardMessage(userId) {
  return getUser(userId)?.dashboardMessageId || null
}

function clearDashboardMessage(userId) {
  const user = getUser(userId)
  if (!user) return
  user.dashboardMessageId = null
  save()
}

function numberOwner(number) {
  const normalized = normalizeNumber(number)
  for (const u of Object.values(data.users)) {
    const found = (u.numbers || []).find((n) => n.number === normalized)
    if (found) return u.userId
  }
  return null
}

function addNumber(userId, number, chatId) {
  const normalized = normalizeNumber(number)
  ensureUser(userId, chatId)
  const u = data.users[userId]

  if ((u.numbers || []).some((n) => n.number === normalized)) {
    throw new Error('already_linked')
  }

  const owner = numberOwner(normalized)
  if (owner !== null && owner !== userId) {
    throw new Error('linked_other')
  }

  u.numbers.push(
    normalizeNumberRecord({
      number: normalized,
      linkedAt: Date.now(),
      status: 'new',
      emoji: DEFAULT_EMOJI,
    })
  )
  save()
  return getNumber(userId, normalized)
}

function getNumber(userId, number) {
  const normalized = normalizeNumber(number)
  const u = getUser(userId)
  if (!u) return null
  return (u.numbers || []).find((n) => n.number === normalized) || null
}

function setEmoji(userId, number, emoji) {
  const n = getNumber(userId, number)
  if (!n) throw new Error('not_found')
  n.emoji =
    typeof emoji === 'string' && emoji.trim().length ? emoji.trim() : DEFAULT_EMOJI
  save()
  return n
}

function getEmoji(userId, number) {
  const n = getNumber(userId, number)
  return n ? n.emoji || DEFAULT_EMOJI : DEFAULT_EMOJI
}

function setStatus(userId, number, status) {
  const n = getNumber(userId, number)
  if (!n) return
  n.status = status
  save()
}

function removeNumber(userId, number) {
  const normalized = normalizeNumber(number)
  const u = getUser(userId)
  if (!u) return
  u.numbers = (u.numbers || []).filter((n) => n.number !== normalized)
  save()
}

function getAllNumbers() {
  const out = []
  for (const u of Object.values(data.users)) {
    for (const n of u.numbers || []) {
      out.push({
        userId: u.userId,
        chatId: u.chatId,
        ...normalizeNumberRecord(n),
      })
    }
  }
  return out
}

module.exports = {
  DEFAULT_EMOJI,
  load,
  ensureUser,
  getUser,
  getUserByChatId,
  setDashboardMessage,
  getDashboardMessage,
  clearDashboardMessage,
  addNumber,
  getNumber,
  setEmoji,
  getEmoji,
  setStatus,
  removeNumber,
  getAllNumbers,
  numberOwner,
}
