'use strict';

/**
 * Tiny conversation-state machine.
 * A user can be in one of the following states:
 *   idle
 *   waiting_number       -> expecting phone number (digits only)
 *   waiting_emoji_index  -> expecting chosen phone number to edit emojis for
 *   waiting_emojis       -> expecting emoji(s)
 *   waiting_delete_index -> expecting chosen phone number to delete
 */
const STATES = Object.freeze({
  IDLE: 'idle',
  WAIT_NUMBER: 'waiting_number',
  WAIT_EMOJI_INDEX: 'waiting_emoji_index',
  WAIT_EMOJIS: 'waiting_emojis',
  WAIT_DELETE_INDEX: 'waiting_delete_index',
});

class StateStore {
  constructor() {
    this.map = new Map();
  }
  set(chatId, state, payload = {}) {
    this.map.set(chatId, { state, payload, ts: Date.now() });
  }
  get(chatId) {
    return this.map.get(chatId) || { state: STATES.IDLE, payload: {} };
  }
  reset(chatId) {
    this.map.delete(chatId);
  }
}

module.exports = { STATES, StateStore };
