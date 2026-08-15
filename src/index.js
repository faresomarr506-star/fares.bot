'use strict';

const mongoose = require('mongoose');
const config = require('./config');
const logger = require('./utils/logger');
const { buildBot } = require('./telegram/bot');
const { restoreAllFromDB } = require('./whatsapp/socket');

async function main() {
  logger.info('connecting to MongoDB...');
  await mongoose.connect(config.mongoUri, { dbName: config.dbName });
  logger.info('MongoDB connected');

  // Waits until Mongo's connection is fully ready
  if (mongoose.connection.readyState !== 1) {
    await new Promise((resolve, reject) => {
      mongoose.connection.once('open', resolve);
      mongoose.connection.once('error', reject);
    });
  }

  // auto-restore all previously paired sessions
  try {
    const restored = await restoreAllFromDB();
    logger.info({ restored }, 'restored sessions on boot');
  } catch (e) {
    logger.error({ e: e?.message }, 'failed to restore sessions');
  }

  const bot = buildBot();
  await bot.launch();
  logger.info('Telegram bot launched');

  const shutdown = async (signal) => {
    logger.info({ signal }, 'shutting down');
    try { await bot.stop(signal); } catch (_) {}
    try { await mongoose.disconnect(); } catch (_) {}
    process.exit(0);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((e) => {
  logger.error({ e: e?.message, stack: e?.stack }, 'fatal error');
  process.exit(1);
});
