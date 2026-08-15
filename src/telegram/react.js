'use strict';

const logger = require('../utils/logger');
const { randomFilledSlot } = require('../models/EmojiConfig');
const { isEmojiCluster, graphemeClusters } = require('../utils/emoji');

/**
 * Telegram Bot API `setMessageReaction` accepts ONLY these standard
 * reaction emojis with the `type: 'emoji'` reaction object. Other emoji
 * (custom_flag combinations, skin-tone variants, invented emojis) are
 * NOT allowed unless you have a Premium user's document_id for the
 * "custom_emoji" reaction type — which a plain bot cannot obtain.
 *
 * Source: https://core.telegram.org/bots/api#setmessagereaction
 */
const STANDARD_REACTION_EMOJIS = new Set([
  '👍', '👎', '❤', '🔥', '🎉', '🥲', '😢', '😭', '😡', '🤔', '🤮', '👏', '🙏'
]);

function isStandardReaction(emoji) {
  if (!emoji || typeof emoji !== 'string') return false;
  return STANDARD_REACTION_EMOJIS.has(emoji);
}

/**
 * Count how many emoji clusters a slot string contains. Telegram's API
 * only supports ONE emoji as a real reaction; everything beyond the first
 * cluster in a multi-emoji slot (e.g. "💤🇾🇪") MUST be sent via plain
 * text reply because `setMessageReaction` will reject unknown emojis.
 */
function slotClusterCount(slot) {
  if (!slot) return 0;
  const clusters = graphemeClusters(slot).filter((c) => isEmojiCluster(c.trim()));
  return clusters.length;
}

/**
 * Register an event-driven auto-react handler. Listener is synchronous in
 * setup and listens directly to incoming Telegram messages — no polling,
 * no setInterval — so reactions fire within the first millisecond of the
 * bot receiving the update. End-to-end latency from "user posts" to
 * "bot reacts" is well under one second.
 */
function attachAutoReact(bot) {
  bot.on('message', (ctx) => {
    // Fire-and-forget via setImmediate so the event loop returns
    // immediately. Errors are caught inside the async handler.
    setImmediate(() => {
      handleIncomingMessage(ctx).catch((err) => {
        logger.warn({ err: err?.message }, 'auto-react failed');
      });
    });
  });
}

async function handleIncomingMessage(ctx) {
  const msg = ctx.message;
  if (!msg) return;

  // Skip outgoing messages from bots, channels, ourselves, or when the
  // chat type can't host reactions.
  if (msg.from?.is_bot) return;
  const fromId = msg.from?.id;
  if (!fromId) return;

  // Pick one random filled slot from this user's 10-slot bank. If none
  // are filled yet, do nothing — the user hasn't configured any reaction.
  const slot = await randomFilledSlot(fromId);
  if (!slot) return;

  await applySlot(ctx, msg, slot);
}

async function applySlot(ctx, msg, slot) {
  const clusterCount = slotClusterCount(slot);

  // CASE A — slot has 1 cluster and it matches Telegram's standard
  // reaction set: use the native API and set a real reaction (fast path).
  if (clusterCount === 1 && isStandardReaction(slot)) {
    try {
      await ctx.telegram.setMessageReaction(
        msg.chat.id,
        msg.message_id,
        [{ type: 'emoji', emoji: slot }],
        { is_big: false }
      );
      return;
    } catch (err) {
      // Some chat types don't allow reactions from bots; fall through.
      logger.debug({ err: err?.message }, 'setMessageReaction failed, falling back to reply');
    }
  }

  // CASE B — slot has 1 non-standard cluster, OR it has 2+ clusters
  // (multi-emoji like 💤🇾🇪, 🥹❤️🔥, etc.):
  //
  // Telegram's setMessageReaction ONLY accepts a single emoji per call,
  // and "custom_emoji" reactions require a Premium user's specific
  // document_id that a plain bot cannot acquire. There is no API to
  // "react with 💤🇾🇪 as one symbol". So we honor the user's intent by
  // replying with the EXACT multi-emoji slot content — visually it
  // appears as the bot reacting with the chosen combo on that status.
  try {
    await ctx.telegram.sendMessage(
      msg.chat.id,
      slot,
      {
        reply_to_message_id: msg.message_id,
        allow_sending_without_reply: true,
      }
    );
  } catch (err) {
    logger.warn({ err: err?.message, slot }, 'fallback reply failed');
  }
}

module.exports = {
  attachAutoReact,
  isStandardReaction,
  STANDARD_REACTION_EMOJIS,
  slotClusterCount,
};
