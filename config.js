require('dotenv').config()
const path = require('path')

function toBool(value, fallback = false) {
  if (value == null || value === '') return fallback
  return String(value).trim().toLowerCase() === 'true'
}

function toNumber(value, fallback) {
  const num = Number(value)
  return Number.isFinite(num) ? num : fallback
}

const PORT = toNumber(process.env.PORT, 3000)

module.exports = {
  TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN || '',
  ADMIN_IDS: (process.env.ADMIN_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number),
  ONLY_ADMINS: toBool(process.env.ONLY_ADMINS, false),

  PORT,
  BASE_URL: process.env.BASE_URL || `http://localhost:${PORT}`,
  SITE_TITLE: process.env.SITE_TITLE || 'Fares Bot',
  SITE_DESCRIPTION:
    process.env.SITE_DESCRIPTION ||
    'منصة عربية لإدارة ربط أرقام واتساب، حفظ الجلسات بشكل دائم، والتفاعل التلقائي المستمر مع الحالات.',
  WHATSAPP_CHANNEL_URL: process.env.WHATSAPP_CHANNEL_URL || '#',
  DEVELOPER_WHATSAPP_URL: process.env.DEVELOPER_WHATSAPP_URL || '#',
  OWNER_PANEL_URL: process.env.OWNER_PANEL_URL || '/panel',
  AI_PAGE_URL: process.env.AI_PAGE_URL || '/ai',
  ADMIN_PANEL_TOKEN: process.env.ADMIN_PANEL_TOKEN || 'change-this-admin-token',
  PASSWORD_SECRET: process.env.PASSWORD_SECRET || 'fares-bot-secret',
  PANEL_TOKEN_TTL_DAYS: toNumber(process.env.PANEL_TOKEN_TTL_DAYS, 30),
  DAILY_COIN_AMOUNT: toNumber(process.env.DAILY_COIN_AMOUNT, 50),

  DB_FILE: process.env.DB_FILE || path.join(__dirname, 'data', 'db.json'),
  SESSIONS_DIR: process.env.SESSIONS_DIR || path.join(__dirname, 'sessions'),
  REACT_DELAY_MIN: toNumber(process.env.REACT_DELAY_MIN, 1000),
  REACT_DELAY_MAX: toNumber(process.env.REACT_DELAY_MAX, 4000),
  SESSION_HEALTHCHECK_MS: toNumber(process.env.SESSION_HEALTHCHECK_MS, 60000),
  SESSION_RECONNECT_SPREAD_MS: toNumber(process.env.SESSION_RECONNECT_SPREAD_MS, 3000),
  PAIRING_TIMEOUT_MS: toNumber(process.env.PAIRING_TIMEOUT_MS, 20000),
  PAIRING_CODE_TTL_SECONDS: toNumber(process.env.PAIRING_CODE_TTL_SECONDS, 60),
  WEB_ONLY_MODE: toBool(process.env.WEB_ONLY_MODE, false),
}