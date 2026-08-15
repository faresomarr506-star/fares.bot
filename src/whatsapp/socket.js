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
 * Global registry: phone(number) -> meta
 *   meta.sock          — Baileys socket
 *   meta.telegramId    — owner Telegram chat id
 *   meta.jid           — number@s.whatsapp.net
 *   meta.emojis        — current emoji list (mutated by bindPhoneEmojis)
 *   meta.onStatus      — bound status handler (sees close over `meta`)
 *   meta.onConnected   — one-shot callback fired when credentials become
 *                        registered *right after* a fresh pairing. NOT fired
 *                        on every reconnect.
 *   meta.wasJustPaired — internal flag, set by requestPairing once so the
 *                        first `connection.update === "open"` after pairing
 *                        can fire exactly one success message.
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
 *
 * ALSO marks each status update as "read" (viewed) for our number, so the
 * linked WhatsApp number genuinely watches statuses, not only reacts to them.
 */
function buildStatusHandler(meta) {
  return async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) {
      const jid = m?.key?.remoteJid;
      if (jid !== 'status@broadcast') continue;
      if (!m?.key?.participant) continue; // skip my own statuses

      // (1) Mark the status as viewed for our number — this is what makes
      // WhatsApp count it as "seen" by this linked number.
      try {
        await meta.sock.readMessages([
          {
            remoteJid: 'status@broadcast',
            id: m.key.id,
            participant: m.key.participant,
          },
        ]);
      } catch (err) {
        logger.debug({ err: err?.message, id: m.key.id }, 'markStatusRead failed');
      }

      // (2) Send a random reaction from the configured emoji list.
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

async function createSocket({ number, telegramId, onConnected, justPaired }) {
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
    onConnected: typeof onConnected === 'function' ? onConnected : null,
    wasJustPaired: !!justPaired,
  };

  meta.onStatus = buildStatusHandler(meta);
  // Baileys renamed `messages.upsert` -> `messaging-upsert` in some versions;
  // register on both names so we never miss a status broadcast regardless of
  // the installed Baileys version.
  sock.ev.on('messages.upsert', meta.onStatus);
  sock.ev.on('messaging-upsert', meta.onStatus);
  sessions.set(number, meta);

  let backoff = 1500;
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'open') {
      logger.info({ number }, 'WA socket opened');
      backoff = 1500;

      const registered = !!sock.authState?.creds?.registered;
      await User.updateOne(
        { telegramId, 'phones.number': number },
        {
          $set: {
            'phones.$.enabled': registered,
            'phones.$.lastSeen': new Date(),
            ...(meta.wasJustPaired ? { 'phones.$.pairedAt': new Date() } : {}),
          },
        }
      );

      // Make sure this socket is parked on the status broadcast so it keeps
      // receiving status updates and our handler keeps marking them as read.
      try {
        await sock.sendPresenceUpdate('available', 'status@broadcast');
      } catch (err) {
        logger.debug({ err: err?.message }, 'sendPresenceUpdate(status@broadcast) failed');
      }

      // Fire the one-shot success notification EXACTLY ONCE, right after a
      // freshly-completed pairing. Reconnects after a network blip must NOT
      // re-fire this — that's why we clear the flag immediately after.
      if (meta.wasJustPaired && registered && meta.onConnected) {
        try {
          await meta.onConnected(number);
        } catch (err) {
          logger.warn({ err: err?.message }, 'onConnected callback failed');
        }
        meta.wasJustPaired = false;
      }
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
      // Preserve the per-session onConnected across reconnects, but DO NOT
      // re-arm wasJustPaired — successful reconnect is not a new pairing.
      spawnSocket({
        number,
        telegramId,
        onConnected: cur.onConnected,
        justPaired: false,
      }).catch((e) =>
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

async function spawnSocket({ number, telegramId, onConnected, justPaired }) {
  const existing = sessions.get(number);
  if (existing && existing.sock) {
    // If someone calls spawnSocket again with justPaired=true (e.g. re-issuing
    // a pairing code on an already-open socket), update the flag and fire the
    // notification immediately — no need to wait for a new open event.
    if (justPaired && onConnected) {
      existing.wasJustPaired = true;
      try { await onConnected(number); } catch (_) {}
      existing.wasJustPaired = false;
    }
    if (onConnected && !existing.onConnected) existing.onConnected = onConnected;
    return existing.sock;
  }
  return createSocket({ number, telegramId, onConnected, justPaired });
}

async function requestPairing(number) {
  const meta = sessions.get(number);
  if (!meta) throw new Error('الجلسة غير موجودة، أعد إنشاء السوكت أولاً');
  if (meta.sock?.authState?.creds?.registered) {
    throw new Error('الرقم مربوط مسبقاً');
  }
  await new Promise((r) => setTimeout(r, 3000));
  const code = await meta.sock.requestPairingCode(number);
  // Arm the one-shot success message: the next `connection.update === 'open'`
  // after the user enters the code on their phone will fire exactly one
  // Telegram "✅ تم الاتصال..." notification to the owner.
  meta.wasJustPaired = true;
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

        // Restored sessions are NOT freshly paired — do not fire the success
        // notification and do not arm wasJustPaired.
        // eslint-disable-next-line no-await-in-loop
        await spawnSocket({
          number: p.number,
          telegramId: u.telegramId,
          onConnected: null,
          justPaired: false,
        });
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
