'use strict';

require('dotenv').config();

const config = {
  botToken: process.env.BOT_TOKEN || '',
  mongoUri:
    process.env.MONGO_URI ||
    'mongodb+srv://faresomar79:faresaltmimi99@cluster0.0tb0uf9.mongodb.net/?appName=Cluster0',
  dbName: process.env.DB_NAME || 'wa_telegram_bot',
  logLevel: process.env.LOG_LEVEL || 'info',
};

if (!config.botToken) {
  // eslint-disable-next-line no-console
  console.error('[CONFIG] BOT_TOKEN is missing in .env');
  process.exit(1);
}

module.exports = config;
