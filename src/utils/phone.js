'use strict';

/**
 * Strip everything except digits. The phone number must contain
 * digits only (no +, space, dashes or parentheses). Country code
 * is required.
 */
function normalizePhoneNumber(raw) {
  if (raw === undefined || raw === null) return '';
  return String(raw).replace(/\D+/g, '');
}

function isValidPhoneNumber(raw) {
  const n = normalizePhoneNumber(raw);
  // international numbers: 7 to 15 digits (E.164)
  return /^\d{7,15}$/.test(n);
}

function phoneToJid(phone) {
  const n = normalizePhoneNumber(phone);
  return `${n}@s.whatsapp.net`;
}

module.exports = { normalizePhoneNumber, isValidPhoneNumber, phoneToJid };
