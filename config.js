require('dotenv').config()

module.exports = {
  TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN || '',
  ADMIN_IDS: (process.env.ADMIN_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number),
  ONLY_ADMINS: (process.env.ONLY_ADMINS || 'false').toString().toLowerCase() === 'true',
  DB_FILE: process.env.DB_FILE || './data/db.json',
  SESSIONS_DIR: process.env.SESSIONS_DIR || './sessions',
  REACT_DELAY_MIN: Number(process.env.REACT_DELAY_MIN || 1000),
  REACT_DELAY_MAX: Number(process.env.REACT_DELAY_MAX || 4000),
}
