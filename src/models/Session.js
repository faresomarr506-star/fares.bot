'use strict';

const mongoose = require('mongoose');
const { BufferJSON, initAuthCreds, proto } = require('@whiskeysockets/baileys');

/**
 * Mongo-backed auth state for Baileys.
 *
 * We persist:
 *   - the whole `creds` object in `baileys_creds`
 *   - every signal/app-state key by `{ category, id }` in `baileys_keys`
 *
 * Values are serialized with BufferJSON so Buffer/Uint8Array values survive round-trips.
 */
const credSchema = new mongoose.Schema(
  {
    phone: { type: String, required: true, unique: true, index: true },
    creds: { type: mongoose.Schema.Types.Mixed, required: true },
  },
  { collection: 'baileys_creds', timestamps: true }
);

const keySchema = new mongoose.Schema(
  {
    phone: { type: String, required: true, index: true },
    category: { type: String, required: true, index: true },
    id: { type: String, required: true },
    value: { type: mongoose.Schema.Types.Mixed, required: true },
  },
  { collection: 'baileys_keys', timestamps: true }
);
keySchema.index({ phone: 1, category: 1, id: 1 }, { unique: true });

const Cred = mongoose.models.BaileysCred || mongoose.model('BaileysCred', credSchema);
const Key = mongoose.models.BaileysKey || mongoose.model('BaileysKey', keySchema);

function toStoredJson(value) {
  return JSON.parse(JSON.stringify(value, BufferJSON.replacer));
}

function fromStoredJson(value) {
  if (value === null || value === undefined) return null;
  return JSON.parse(JSON.stringify(value), BufferJSON.reviver);
}

function mergeCreds(target, updates) {
  if (!updates || typeof updates !== 'object') return target;

  Object.assign(target, updates);

  if (updates.me) {
    target.me = {
      ...(target.me || {}),
      ...updates.me,
    };
  }

  if (updates.accountSettings) {
    target.accountSettings = {
      ...(target.accountSettings || {}),
      ...updates.accountSettings,
    };
  }

  return target;
}

async function loadStoredCreds(phone) {
  const doc = await Cred.findOne({ phone }).lean();
  return fromStoredJson(doc?.creds);
}

async function hasActiveSession(phone) {
  const storedCreds = await loadStoredCreds(phone);
  return Boolean(storedCreds?.registered && storedCreds?.me?.id);
}

/**
 * Build a Baileys auth state object backed by MongoDB.
 */
async function useMongoDBAuthState(phone) {
  const storedCreds = await loadStoredCreds(phone);
  const baseCreds = initAuthCreds();
  const creds = mergeCreds(baseCreds, storedCreds || {});

  const state = {
    creds,
    keys: {
      get: async (type, ids) => {
        const docs = await Key.find({
          phone,
          category: type,
          id: { $in: ids },
        }).lean();

        const byId = Object.create(null);
        for (const doc of docs) {
          let value = fromStoredJson(doc.value);
          if (type === 'app-state-sync-key' && value) {
            value = proto.Message.AppStateSyncKeyData.fromObject(value);
          }
          byId[doc.id] = value;
        }

        const result = {};
        for (const id of ids) {
          if (typeof byId[id] !== 'undefined') {
            result[id] = byId[id];
          }
        }
        return result;
      },
      set: async (data) => {
        const ops = [];

        for (const category of Object.keys(data || {})) {
          const items = data[category] || {};
          for (const id of Object.keys(items)) {
            const value = items[id];
            if (value === null || typeof value === 'undefined') {
              ops.push(Key.deleteOne({ phone, category, id }));
              continue;
            }

            ops.push(
              Key.updateOne(
                { phone, category, id },
                { $set: { value: toStoredJson(value) } },
                { upsert: true }
              )
            );
          }
        }

        if (ops.length) {
          await Promise.all(ops);
        }
      },
      clear: async () => {
        await Key.deleteMany({ phone });
      },
    },
  };

  const saveCreds = async (updates) => {
    mergeCreds(state.creds, updates);
    await Cred.updateOne(
      { phone },
      { $set: { creds: toStoredJson(state.creds) } },
      { upsert: true }
    );
  };

  const clear = async () => {
    await Cred.deleteOne({ phone });
    await Key.deleteMany({ phone });
  };

  return {
    state,
    saveCreds,
    clear,
    hasStoredCreds: Boolean(storedCreds),
    isRegisteredSession: Boolean(storedCreds?.registered && storedCreds?.me?.id),
  };
}

module.exports = { useMongoDBAuthState, hasActiveSession };
