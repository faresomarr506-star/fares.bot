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
const { useMongoDBAuthState } = require('../models/Session');
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
  const { state, saveCreds, clear } = await useMongoDBAuthState(number);

  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

  const sock = makeWASocket({
    version,
    printQRInTerminal: false,
    mobile: false,
    markOnlineOnConnect: false,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(
        {
          get: async (keyId) => state.appStateKeys?.[keyId] || null,
          set: async (keyId, value) => {
            state.appStateKeys = state.appStateKeys || {};
            state.appStateKeys[keyId] = value;
            await saveCreds();
          },
        },
        logger
      ),
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
    emojis: ['❤️', '🔥'], // default until DB read completes
    onStatus: null,        // assigned below
  };

  // Single status listener attached at creation time. Replaced atomically on emoji
  // changes by re-binding through meta.onStatus (see bindPhoneEmojis below).
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
        { $set: { 'phones.$.lastSeen': new Date() } }
      );
    } else if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      logger.warn({ number, code, loggedOut }, 'WA socket closed');
      if (loggedOut) {
        if (sessions.get(number)?.sock === sock) sessions.delete(number);
        await clear().catch(() => {});
        logger.info({ number }, 'session cleared (logged out)');
        return;
      }
      // exponential reconnect (only if user still owns this socket)
      setTimeout(() => {
        const cur = sessions.get(number);
        if (!cur || cur.sock !== sock) return; // someone replaced us
        if (cur.sock === sock) {
          sessions.delete(number);
          spawnSocket({ number, telegramId }).catch((e) =>
            logger.error({ e: e?.message, number }, 'reconnect failed')
          );
        }
      }, backoff);
      backoff = Math.min(backoff * 2, 30000);
    }
  });

  // Refresh emojis from DB lazily — covers the case where user just added the
  // phone without an explicit email change.
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
  // ensure any partial session wiped before starting fresh
  return createSocket({ number, telegramId });
}

async function requestPairing(number) {
  const meta = sessions.get(number);
  if (!meta) throw new Error('الجلسة غير موجودة، أعد إنشاء السوكت أولاً');
  if (meta.sock?.authState?.creds?.registered) {
    throw new Error('الرقم مربوط مسبقاً');
  }
  // WhatsApp enforces ~3s wait between socket open and pairing code request.
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
