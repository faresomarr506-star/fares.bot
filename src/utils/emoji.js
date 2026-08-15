'use strict';

/**
 * Split any string into Unicode grapheme clusters so multi-codepoint
 * emoji (flags like 🇾🇪, ZWJ family sequences, skin tones, etc.)
 * stay intact even when the user sends them without separators.
 */
function graphemeClusters(input) {
  if (input === undefined || input === null) return [];
  const str = String(input);
  if (!str) return [];

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
    // fall through
  }
  return Array.from(str);
}

function isEmojiCluster(cluster) {
  if (!cluster || typeof cluster !== 'string') return false;
  if (cluster.length > 64) return false;
  if (!/\p{Extended_Pictographic}/u.test(cluster)) return false;
  if (/[\p{L}\p{N}_~`]/u.test(cluster)) return false;
  return true;
}

/**
 * Strip a user's accidental Markdown wrapper characters (backticks,
 * code fences) so the raw emoji content survives intact into the slot.
 */
function stripWrappers(input) {
  return String(input || '')
    .replace(/```+/g, '')
    .replace(/`/g, '')
    .replace(/\\`/g, '')
    .trim();
}

/**
 * Parse a free-form message into emoji clusters, dropping non-emoji pieces.
 */
function parseEmojis(input) {
  const cleaned = stripWrappers(input);
  const clusters = graphemeClusters(cleaned);
  const out = [];
  for (const c of clusters) {
    const trimmed = c.trim();
    if (!trimmed) continue;
    if (isEmojiCluster(trimmed)) out.push(trimmed);
  }
  return out;
}

/**
 * Build ONE "slot" string by gluing emoji clusters back together with NO
 * separator. This is the entry format for the 10-slot system: the slot
 * content can be a single emoji ("❤️") OR a glued multi-emoji combo
 * ("💤🇾🇪", "🥹❤️🔥") — the user sends it "as is", with no separators.
 *
 * Returns '' if the input contains no usable emoji cluster.
 */
function normalizeSlot(input) {
  const cleaned = stripWrappers(input);
  if (!cleaned) return '';
  const clusters = parseEmojis(cleaned);
  if (!clusters.length) return '';
  // Glue back together — NO separator, exactly as the user sent it.
  return clusters.join('');
}

module.exports = {
  graphemeClusters,
  isEmojiCluster,
  parseEmojis,
  normalizeSlot,
  stripWrappers,
};
