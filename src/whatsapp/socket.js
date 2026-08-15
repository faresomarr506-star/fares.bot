'use strict';

const NodeCache = require('node-cache');
const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} = require('@whiskeysockets/baileys');
const qrcodeTerminal = require('qrcode-terminal');
const logger = require('../utils/logger');
const { phoneToJid } = require('../utils/phone');
const { useMongoDBAuthState } = require('../models/Session');
const { User } = require('../models/User');

/**
 * Global registry: phone(JID) -> WASocket instance + metadata.
 */
const sessions = new Map();
const recentReactionCache = new NodeCache({ stdTTL: 60 * 60 * 24 * 30, checkperiod: 60 });

function pickEmoji(list) {
  if (!list || !list.length) return '❤️';
  return list[Math.floor(Math.random() * list.length)];
}

async function dispatchReaction(sock, statusMessage, emoji, keyExtra = {}) {
  // statusMessage has .key with { remoteJid: 'status@broadcast', id, participant }
  const sender = statusMessage?.key?.participant;
  if (!sender) return;
  const cacheKey = `${sender}:${statusMessage.key.id}:${emoji}`;
  if (recentReactionCache.get(cacheKey)) return;
  try {
    await sock.sendMessage(
      'status@broadcast',
      {
        react: {
          text: emoji,
          key: statusMessage.key,
        },
      },
      {
        statusJidList: [sender],
      }
    );
    recentReactionCache.set(cacheKey, true);
  } catch (err) {
    logger.warn({ err: err?.message, sender }, 'status react failed');
  }
}

async function onStatusMessages(phoneData, sock) {
  // We rely on messages.upsert. When the message key is status@broadcast we react.
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) {
      const remote = m?.key?.remoteJid;
      if (remote !== 'status@broadcast') continue;
      // ignore own statuses
      if (!m?.key?.participant) continue;
      const emoji = pickEmoji(phoneData.emojis || []);
      // small delay to ensure the status has settled (< 1s)
      setTimeout(() => dispatchReaction(sock, m, emoji), 250);
    }
  });
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

  // backoff reconnect on close (only if not logged out)
  let backoff = 1500;
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      try {
        qrcodeTerminal.generate(qr, { small: true });
      } catch (_) {}
    }
    if (connection === 'open') {
      logger.info({ number }, 'WA socket opened');
      await User.updateOne(
        { telegramId, 'phones.number': number },
        { $set: { 'phones.$.lastSeen': new Date() } }
      );
      backoff = 1500;
    } else if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      logger.warn({ number, code, loggedOut }, 'WA socket closed');
      if (loggedOut) {
        sessions.delete(number);
        await clear();
        logger.info({ number }, 'session cleared (logged out)');
        return;
      }
      // exponential reconnect
      setTimeout(() => {
        if (sessions.has(number)) {
          // re-create the socket transparently
          sessions.delete(number);
          spawnSocket({ number, telegramId }).catch((e) =>
            logger.error({ e: e?.message, number }, 'reconnect failed')
          );
        }
      }, backoff);
      backoff = Math.min(backoff * 2, 30000);
    }
  });

  await onStatusMessages({ emojis: ['❤️', '🔥'] }, sock);

  sessions.set(number, { sock, telegramId, jid });

  // If session already registered, just listen for statuses and react.
  return sock;
}

async function spawnSocket({ number, telegramId }) {
  const existing = sessions.get(number);
  if (existing && existing.sock) {
    try {
      existing.sock.ev.flush?.(); // no-op for compat
      // socket already running
      return existing.sock;
    } catch (_) {}
  }
  return createSocket({ number, telegramId });
}

async function requestPairing(number) {
  const meta = sessions.get(number);
  if (!meta) {
    throw new Error('الجلسة غير موجودة، أعد إنشاء السوكت أولاً');
  }
  if (meta.sock?.authState?.creds?.registered) {
    throw new Error('الرقم مربوط مسبقاً');
  }
  // WhatsApp enforces ~3s wait between socket open and pairing code request
  await new Promise((r) => setTimeout(r, 3000));
  const code = await meta.sock.requestPairingCode(number);
  return code;
}

async function bindPhoneEmojis(number, emojis) {
  const meta = sessions.get(number);
  if (!meta) return;
  // re-attach the listener with new emojis by updating an internal reference
  // we replace the listener with a functional one bound to new emojis:
  meta.emojis = emojis;
  if (!meta.attached) {
    meta.attached = true;
    meta.sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const m of messages) {
        if (m?.key?.remoteJid !== 'status@broadcast') continue;
        if (!m?.key?.participant) continue;
        const e = pickEmoji(meta.emojis || []);
        setTimeout(() => dispatchReaction(meta.sock, m, e), 250);
      }
    });
  }
}

async function logoutPhone(number) {
  const meta = sessions.get(number);
  if (!meta) return false;
  try {
    await meta.sock.logout();
  } catch (_) {}
  try {
    meta.sock.end?.();
  } catch (_) {}
  sessions.delete(number);
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

module.exports = {
  sessions,
  spawnSocket,
  requestPairing,
  bindPhoneEmojis,
  logoutPhone,
  restoreAllFromDB,
};
