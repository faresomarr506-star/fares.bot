'use strict';

const mongoose = require('mongoose');

const MAX_SLOTS = 10;

const slotSchema = new mongoose.Schema(
  { text: { type: String, default: '' } },
  { _id: false }
);

const configSchema = new mongoose.Schema(
  {
    telegramId: { type: Number, required: true, unique: true, index: true },
    chatId: { type: Number, default: null },
    // Up to MAX_SLOTS slots. Each slot.text may contain 1 OR many emoji
    // clusters glued together with no separator, e.g. "💤🇾🇪".
    slots: { type: [slotSchema], default: undefined },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

function freshSlots() {
  return Array.from({ length: MAX_SLOTS }, () => ({ text: '' }));
}

const EmojiConfig =
  mongoose.models.EmojiConfig || mongoose.model('EmojiConfig', configSchema);

async function getConfig(telegramId) {
  let doc = await EmojiConfig.findOne({ telegramId });
  if (!doc) {
    doc = await EmojiConfig.create({ telegramId, slots: freshSlots() });
  }
  if (!doc.slots || doc.slots.length !== MAX_SLOTS) {
    const slots = freshSlots();
    if (Array.isArray(doc.slots)) {
      for (let i = 0; i < Math.min(doc.slots.length, MAX_SLOTS); i++) {
        slots[i].text = String(doc.slots[i]?.text || '');
      }
    }
    doc.slots = slots;
    await doc.save();
  }
  return doc;
}

async function setSlot(telegramId, idx, text) {
  if (idx < 0 || idx >= MAX_SLOTS) return null;
  const doc = await getConfig(telegramId);
  doc.slots[idx].text = String(text || '');
  await doc.save();
  return doc;
}

async function clearSlot(telegramId, idx) {
  return setSlot(telegramId, idx, '');
}

/**
 * Pick a random filled slot from the user's 10 slots. The returned string
 * may be one emoji ("❤️") or a glued multi-emoji combination ("💤🇾🇪").
 * Returns null if no slot is filled.
 */
async function randomFilledSlot(telegramId) {
  const doc = await getConfig(telegramId);
  const filled = doc.slots
    .map((s) => String(s?.text || '').trim())
    .filter((t) => t.length > 0);
  if (!filled.length) return null;
  return filled[Math.floor(Math.random() * filled.length)];
}

module.exports = {
  EmojiConfig,
  getConfig,
  setSlot,
  clearSlot,
  randomFilledSlot,
  MAX_SLOTS,
  freshSlots,
};
