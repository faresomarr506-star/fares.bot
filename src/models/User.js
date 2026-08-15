'use strict';

const mongoose = require('mongoose');

const phoneSchema = new mongoose.Schema(
  {
    jid: { type: String, required: true },
    number: { type: String, required: true },
    emojis: { type: [String], default: ['❤️', '🔥'] },
    enabled: { type: Boolean, default: true },
    pairedAt: { type: Date, default: Date.now },
    lastSeen: { type: Date, default: null },
  },
  { _id: true }
);

const userSchema = new mongoose.Schema(
  {
    telegramId: { type: Number, required: true, unique: true, index: true },
    username: { type: String, default: null },
    firstName: { type: String, default: null },
    phones: { type: [phoneSchema], default: [] },
  },
  { timestamps: true }
);

const User = mongoose.model('User', userSchema);

async function findOrCreateUser(telegramId, profile = {}) {
  let u = await User.findOne({ telegramId });
  if (!u) {
    u = await User.create({
      telegramId,
      username: profile.username || null,
      firstName: profile.first_name || null,
      phones: [],
    });
  } else if (profile.username || profile.first_name) {
    let dirty = false;
    if (profile.username && u.username !== profile.username) {
      u.username = profile.username;
      dirty = true;
    }
    if (profile.first_name && u.firstName !== profile.first_name) {
      u.firstName = profile.first_name;
      dirty = true;
    }
    if (dirty) await u.save();
  }
  return u;
}

async function addPhone(telegramId, number, jid) {
  const u = await User.findOne({ telegramId });
  if (!u) return null;
  const exists = u.phones.find((p) => p.number === number);
  if (exists) {
    exists.jid = jid;
    exists.enabled = true;
  } else {
    u.phones.push({
      jid,
      number,
      emojis: ['❤️', '🔥'],
      enabled: true,
      pairedAt: new Date(),
      lastSeen: null,
    });
  }
  await u.save();
  return u;
}

async function removePhone(telegramId, number) {
  const u = await User.findOne({ telegramId });
  if (!u) return null;
  u.phones = u.phones.filter((p) => p.number !== number);
  await u.save();
  return u;
}

async function setEmojis(telegramId, number, emojis) {
  const u = await User.findOne({ telegramId });
  if (!u) return null;
  const p = u.phones.find((x) => x.number === number);
  if (!p) return null;
  p.emojis = emojis;
  await u.save();
  return p;
}

async function getPhone(telegramId, number) {
  const u = await User.findOne({ telegramId });
  if (!u) return null;
  return u.phones.find((x) => x.number === number) || null;
}

module.exports = {
  User,
  findOrCreateUser,
  addPhone,
  removePhone,
  setEmojis,
  getPhone,
};
