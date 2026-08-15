'use strict';

const NodeCache = require('node-cache');
const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} = require('@whiskeysockets/baileys');
const logger = require('../utils/logger');
const { phoneToJid } = require('../utils/phone');
const { useMongoDBAuthState, hasActiveSession } = require('../models/Session');
const { User } = require('../models/User');

/**
 * Global registry: phone(number) -> { sock, telegramId, jid, emojis, onStatus }
 * We keep ONE status listener per session so changing emojis just mutates meta.emojis.
 */
const sessions = new Map();

/** Avoid reacting to the same status+emoji combination within the TTL window. */
const reactionCache = new NodeCache({ stdTTL: 60 * 60 * 24 * 30, checkperiod: 60 });

function pickEmoji(list) {
  if (!list || !list.length) return '❤️';
  return list[Math.floor(Math.random() * list.length)];
}

/**
 * Build the per-session status reaction handler. Bound to meta so emoji list
 * refreshes automatically when binder updates meta.emojis.
 */
function buildStatusHandler(meta) {
  return async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) {
      if (m?.key?.remoteJid !== 'status@broadcast') continue;
      if (!m?.key?.participant) continue; // skip my own statuses
      const emoji = pickEmoji(meta.emojis);
      const cacheKey = `${m.key.participant}:${m.key.id}:${emoji}`;
      if (reactionCache.get(cacheKey)) continue;
      try {
        await meta.sock.sendMessage(
          'status@broadcast',
          { react: { text: emoji, key: m.key } },
          { statusJidList: [m.key.participant] }
        );
        reactionCache.set(cacheKey, true);
      } catch (err) {
        logger.warn({ err: err?.message, participant: m.key.participant }, 'status react failed');
      }
    }
  };
}

async function createSocket({ number, telegramId }) {
  const jid = phoneToJid(number);
  const auth = await useMongoDBAuthState(number);
  const { state, saveCreds, clear } = auth;

  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

  const sock = makeWASocket({
    version,
    printQRInTerminal: false,
    mobile: false,
    markOnlineOnConnect: false,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    generateHighQualityLinkPreview: false,
    logger,
    browser: ['Ubuntu', 'Chrome', '120.0.0'],
  });

  sock.ev.on('creds.update', saveCreds);

  const meta = {
    sock,
    telegramId,
    jid,
    emojis: ['❤️', '🔥'],
    onStatus: null,
  };

  meta.onStatus = buildStatusHandler(meta);
  sock.ev.on('messages.upsert', meta.onStatus);
  sessions.set(number, meta);

  let backoff = 1500;
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'open') {
      logger.info({ number }, 'WA socket opened');
      backoff = 1500;
      await User.updateOne(
        { telegramId, 'phones.number': number },
        {
          $set: {
            'phones.$.enabled': true,
            'phones.$.lastSeen': new Date(),
          },
        }
      );
      return;
    }

    if (connection !== 'close') return;

    const code = lastDisconnect?.error?.output?.statusCode;
    const loggedOut = code === DisconnectReason.loggedOut;
    logger.warn({ number, code, loggedOut }, 'WA socket closed');

    if (loggedOut) {
      if (sessions.get(number)?.sock === sock) sessions.delete(number);
      await clear().catch(() => {});
      await User.updateOne(
        { telegramId, 'phones.number': number },
        { $set: { 'phones.$.enabled': false } }
      ).catch(() => {});
      logger.info({ number }, 'session cleared (logged out)');
      return;
    }

    setTimeout(() => {
      const cur = sessions.get(number);
      if (!cur || cur.sock !== sock) return;
      sessions.delete(number);
      spawnSocket({ number, telegramId }).catch((e) =>
        logger.error({ e: e?.message, number }, 'reconnect failed')
      );
    }, backoff);

    backoff = Math.min(backoff * 2, 30000);
  });

  try {
    const u = await User.findOne({ telegramId });
    const p = (u?.phones || []).find((x) => x.number === number);
    if (p?.emojis?.length) meta.emojis = p.emojis;
  } catch (_) {}

  return sock;
}

async function spawnSocket({ number, telegramId }) {
  const existing = sessions.get(number);
  if (existing && existing.sock) return existing.sock;
  return createSocket({ number, telegramId });
}

async function requestPairing(number) {
  const meta = sessions.get(number);
  if (!meta) throw new Error('الجلسة غير موجودة، أعد إنشاء السوكت أولاً');
  if (meta.sock?.authState?.creds?.registered) {
    throw new Error('الرقم مربوط مسبقاً');
  }
  await new Promise((r) => setTimeout(r, 3000));
  const code = await meta.sock.requestPairingCode(number);
  return code;
}

async function bindPhoneEmojis(number, emojis) {
  const meta = sessions.get(number);
  if (!meta) return false;
  if (!Array.isArray(emojis) || !emojis.length) return false;
  meta.emojis = emojis;
  return true;
}

async function logoutPhone(number) {
  const meta = sessions.get(number);
  if (!meta) return false;
  try { await meta.sock.logout(); } catch (_) {}
  try { meta.sock.end?.(); } catch (_) {}
  if (sessions.get(number)?.sock === meta.sock) sessions.delete(number);
  return true;
}

async function restoreAllFromDB() {
  const users = await User.find({});
  let count = 0;

  for (const u of users) {
    for (const p of u.phones) {
      if (!p.enabled) continue;

      try {
        // eslint-disable-next-line no-await-in-loop
        const active = await hasActiveSession(p.number);
        if (!active) {
          // Phone exists in the user profile, but no valid Baileys auth session
          // was stored yet. Disable restore for it to avoid boot-time crashes.
          // eslint-disable-next-line no-await-in-loop
          await User.updateOne(
            { telegramId: u.telegramId, 'phones.number': p.number },
            { $set: { 'phones.$.enabled': false } }
          );
          logger.warn({ number: p.number }, 'skipping restore: no valid stored session');
          continue;
        }

        // eslint-disable-next-line no-await-in-loop
        await spawnSocket({ number: p.number, telegramId: u.telegramId });
        // eslint-disable-next-line no-await-in-loop
        await bindPhoneEmojis(p.number, p.emojis);
        count++;
      } catch (e) {
        logger.error({ e: e?.message, number: p.number }, 'failed to restore session');
      }
    }
  }

  return count;
}

function getActiveSessionPhones() {
  return Array.from(sessions.keys());
}

module.exports = {
  sessions,
  spawnSocket,
  requestPairing,
  bindPhoneEmojis,
  logoutPhone,
  restoreAllFromDB,
  getActiveSessionPhones,
};
