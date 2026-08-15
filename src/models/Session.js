'use strict';

const mongoose = require('mongoose');

/**
 * Per-phone session storage used as a custom Baileys auth state.
 * Two collections are used:
 *   - credentials: one doc per phone holding `creds` JSON
 *   - app_state_sync_keys / app_state: list of noise/app keys
 *
 * This layout covers the bindState/saveCreds/mongoDbAuthState semantics
 * implemented historically for WhiskeySockets/Baileys.
 */
const credSchema = new mongoose.Schema(
  {
    phone: { type: String, required: true, unique: true, index: true },
    creds: { type: Object, required: true },
  },
  { collection: 'baileys_creds', timestamps: true }
);

const appStateSchema = new mongoose.Schema(
  {
    phone: { type: String, required: true, index: true },
    keyId: { type: String, required: true },
    value: { type: Object, required: true },
  },
  { collection: 'baileys_app_state', timestamps: true }
);
appStateSchema.index({ phone: 1, keyId: 1 }, { unique: true });

const Cred = mongoose.model('BaileysCred', credSchema);
const AppState = mongoose.model('BaileysAppState', appStateSchema);

const FIXED_KEYS = ['noise-key', 'signed-identity-key', 'signed-pre-key', 'app-state-sync-key'];

/**
 * Build a Baileys auth state object backed by MongoDB.
 * Implements the contract expected by makeWASocket: { state, saveCreds, clear }.
 */
async function useMongoDBAuthState(phone) {
  const write = async (keyId, value) => {
    if (!FIXED_KEYS.includes(keyId)) {
      await AppState.updateOne(
        { phone, keyId },
        { $set: { value } },
        { upsert: true }
      );
      return;
    }
    if (keyId === 'app-state-sync-key') {
      const list = value || {};
      await AppState.deleteMany({ phone, keyId: { $ne: keyId } });
      for (const k of Object.keys(list)) {
        await AppState.updateOne(
          { phone, keyId: k },
          { $set: { value: list[k] } },
          { upsert: true }
        );
      }
      return;
    }
    await AppState.updateOne(
      { phone, keyId },
      { $set: { value } },
      { upsert: true }
    );
  };

  const read = async (keyId) => {
    if (keyId === 'creds') {
      const c = await Cred.findOne({ phone }).lean();
      return c ? c.creds : null;
    }
    if (keyId === 'app-state-sync-key') {
      const docs = await AppState.find({ phone }).lean();
      const obj = {};
      for (const d of docs) {
        if (d.keyId !== 'noise-key' &&
            d.keyId !== 'signed-identity-key' &&
            d.keyId !== 'signed-pre-key') {
          obj[d.keyId] = d.value;
        }
      }
      return obj;
    }
    const doc = await AppState.findOne({ phone, keyId }).lean();
    return doc ? doc.value : null;
  };

  const creds = (await read('creds')) || null;
  const appState = (await read('app-state-sync-key')) || {};

  const state = {
    creds,
    noiseKey: await read('noise-key'),
    signedIdentityKey: await read('signed-identity-key'),
    signedPreKey: await read('signed-pre-key'),
    appStateKeys: appState,
  };

  const saveCreds = async () => {
    if (state.creds) {
      await Cred.updateOne(
        { phone },
        { $set: { creds: state.creds } },
        { upsert: true }
      );
    }
    if (state.noiseKey) await write('noise-key', state.noiseKey);
    if (state.signedIdentityKey) await write('signed-identity-key', state.signedIdentityKey);
    if (state.signedPreKey) await write('signed-pre-key', state.signedPreKey);
    if (state.appStateKeys) await write('app-state-sync-key', state.appStateKeys);
  };

  const clear = async () => {
    await Cred.deleteOne({ phone });
    await AppState.deleteMany({ phone });
  };

  return { state, saveCreds, clear };
}

module.exports = { useMongoDBAuthState, FIXED_KEYS };
