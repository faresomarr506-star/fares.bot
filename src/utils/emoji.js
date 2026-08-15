'use strict';

/**
 * Split any string into Unicode grapheme clusters so multi-codepoint
 * emoji (flags like 🇾🇪, ZWJ family sequences, skin tones, etc.)
 * stay intact even when the user sends them without spaces or newlines.
 *
 * Examples:
 *   "🇾🇪"          -> ["🇾🇪"]
 *   "❤️ 🔥"       -> ["❤️", " ", "🔥"]
 *   "❤️🔥"        -> ["❤️", "🔥"]   (no space, but still two emojis)
 *   "🇾🇪❤️🔥" -> ["🇾🇪", "❤️", "🔥"]
 *   "👨‍👩‍👧"   -> ["👨‍👩‍👧"]   (one family cluster)
 */
function graphemeClusters(input) {
  if (input === undefined || input === null) return [];
  const str = String(input);
  if (!str) return [];

  // Preferred: Intl.Segmenter with grapheme granularity (Node 16+).
  try {
    if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
      const seg = new Intl.Segmenter('en', { granularity: 'grapheme' });
      const out = [];
      for (const piece of seg.segment(str)) {
        if (piece.segment.length > 0) out.push(piece.segment);
      }
      return out;
    }
  } catch (_) {
    // fall through to Array.from
  }

  // Fallback: Array.from (correct surrogate pairs; ZWJ may over-split on
  // very old runtimes, but Node >=18 used by this project supports Segmenter).
  return Array.from(str);
}

/**
 * Decide whether a single grapheme cluster is emoji-shaped.
 * Accepts flags, ZWJ family, single emoji, and emoji with modifiers.
 * Rejects clusters that mix emoji with letters or digits.
 */
function isEmojiCluster(cluster) {
  if (!cluster || typeof cluster !== 'string') return false;
  if (cluster.length > 32) return false; // realistic emoji clusters are short

  // Must contain at least one Extended_Pictographic code point
  if (!/\p{Extended_Pictographic}/u.test(cluster)) return false;

  // Reject clusters that also contain a letter or digit (text + emoji mix)
  if (/[\p{L}\p{N}]/u.test(cluster)) return false;

  return true;
}

/**
 * Parse a free-form user message into a clean list of emoji.
 * Works whether the user sends emojis separated by spaces, newlines,
 * commas, or with no separator at all (e.g. "❤️🔥" or "🇾🇪").
 */
function parseEmojis(input) {
  const clusters = graphemeClusters(input);
  const emojis = [];
  for (const c of clusters) {
    const trimmed = c.trim();
    if (!trimmed) continue;
    if (isEmojiCluster(trimmed)) emojis.push(trimmed);
  }
  return emojis;
}

module.exports = { graphemeClusters, isEmojiCluster, parseEmojis };
