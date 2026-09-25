'use strict';

// Deterministic post-validator for analysis output (CB-LISTEN-FIX-1 F4).
//
// Quote EXISTENCE was the only check before this, and it searched the whole
// thread: an item quoting a moderator note, or a commenter's pain attributed
// to the OP, passed. Every list item now names its speaker ("post" or
// "comment N", matching the [comment N] label in the prompt), and its quote
// must be found in THAT unit's text. Excluded units are not in the prompt, so
// they are not in `comments` here either — a quote found only in one can never
// validate.
//
// Failing items are DROPPED AND COUNTED per field and reason, so paraphrase
// drift and speaker bleed are measurable rather than silent. This is a
// grounding check only: it cannot tell whether an item's label says more than
// its quote. Semantic checks are out of scope (model-free by design).

const { FEATURE_BASIS } = require('./taxonomy');
const { promptView } = require('./prompt-view');

// Normalisation: case, whitespace, Markdown links/emphasis/blockquote markers,
// backslash and HTML escapes, curly quotes. Applied identically to the quote
// and to the unit text.
function normalizeForMatch(s) {
  return String(s || '')
    .normalize('NFKC')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#x?27;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\\([\\`*_{}[\]()#+\-.!>~|"'])/g, '$1')
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*>\s?/gm, '')
    .replace(/[*_~`]+/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// "post" → -1; "comment N" (also "[comment N]", "comment:N", "comment #N") → N-1.
function parseSpeaker(speaker) {
  const s = String(speaker || '').trim().toLowerCase();
  if (s === 'post' || s === '[post]') return -1;
  const m = /^\[?\s*comment\s*[:#]?\s*(\d+)\s*\]?$/.exec(s);
  return m ? Number(m[1]) - 1 : null;
}

// Build the unit texts exactly as the model saw them: the post (title + body)
// and the prompt comments in prompt order, both cut where the prompt cuts them
// (CB-LISTEN-FIX-1b R3). A quote from past the cut was never shown.
function unitsFor(post, comments) {
  const view = promptView(post || {}, (comments || []).map((c) => ({ body: (c && c.body) || '' })));
  return {
    post: normalizeForMatch(`${view.title}\n${view.visibleSelftext}`),
    comments: view.visibleComments.map(normalizeForMatch)
  };
}

function groundedIn(units, quote, speaker) {
  const q = normalizeForMatch(quote);
  if (!q) return 'no-quote';
  const idx = parseSpeaker(speaker);
  if (idx === null) return 'bad-speaker';
  const text = idx === -1 ? units.post : units.comments[idx];
  if (text === undefined) return 'bad-speaker';
  return text.includes(q) ? null : 'quote-not-in-unit';
}

// Every list field and its label key. topics and stance_basis are enum lists,
// not items, and carry no quote.
const LIST_FIELDS = {
  pain_points: 'item',
  expected_baseline: 'item',
  ethics_concerns: 'item',
  deal_breakers: 'item',
  trust_signals: 'signal',
  feature_requests: 'feature',
  tools_mentioned: 'tool'
};

// → { analysis, drops: { field: n }, dropReasons: { 'field:reason': n }, checked }
// The input object is not mutated.
function validateAnalysis(analysis, { post, comments } = {}) {
  const out = { ...(analysis || {}) };
  const units = unitsFor(post, comments);
  const drops = {}, dropReasons = {};
  let checked = 0;
  const drop = (field, reason) => {
    drops[field] = (drops[field] || 0) + 1;
    dropReasons[`${field}:${reason}`] = (dropReasons[`${field}:${reason}`] || 0) + 1;
  };

  for (const [field, labelKey] of Object.entries(LIST_FIELDS)) {
    if (!Array.isArray(out[field])) { out[field] = []; continue; }
    out[field] = out[field].filter((item) => {
      checked++;
      if (!item || typeof item !== 'object' || typeof item[labelKey] !== 'string' || !item[labelKey].trim()) {
        drop(field, 'malformed');
        return false;
      }
      if (field === 'feature_requests' && !FEATURE_BASIS.includes(item.basis)) {
        drop(field, 'bad-basis');
        return false;
      }
      const reason = groundedIn(units, item.quote, item.speaker);
      if (reason) { drop(field, reason); return false; }
      return true;
    });
  }

  if (out.persona && typeof out.persona === 'object' && String(out.persona.goal || '').trim()) {
    checked++;
    const reason = groundedIn(units, out.persona.goal_quote, out.persona.goal_speaker);
    if (reason) {
      drop('persona.goal', reason);
      out.persona = { ...out.persona, goal: '', goal_quote: '', goal_speaker: '' };
    }
  }

  if (String(out.notable_quote || '').trim()) {
    checked++;
    const reason = groundedIn(units, out.notable_quote, out.notable_quote_speaker);
    if (reason) {
      drop('notable_quote', reason);
      out.notable_quote = '';
      out.notable_quote_speaker = '';
    }
  }

  // The mix counts comments shown to the model. It cannot exceed that number;
  // an overcount means units were counted that were never in the prompt.
  if (out.comment_stance_mix && typeof out.comment_stance_mix === 'object') {
    const values = Object.values(out.comment_stance_mix);
    const valid = values.every((v) => Number.isInteger(v) && v >= 0);
    const total = valid ? values.reduce((a, b) => a + b, 0) : Infinity;
    if (total > (comments || []).length) {
      drop('comment_stance_mix', valid ? 'overcount' : 'malformed');
      out.comment_stance_mix = Object.fromEntries(Object.keys(out.comment_stance_mix).map((k) => [k, 0]));
    }
  }

  return { analysis: out, drops, dropReasons, checked };
}

// Every v4 quote location, for the audit readers (CB-LISTEN-FIX-1b R4):
// [field, quote] pairs from notable_quote, every list item, and persona.goal.
// Legacy rows simply yield fewer (their extra list items are bare strings).
function quoteEntries(analysis) {
  if (!analysis || typeof analysis !== 'object') return [];
  const out = [];
  if (typeof analysis.notable_quote === 'string' && analysis.notable_quote.trim()) {
    out.push({ field: 'notable_quote', quote: analysis.notable_quote });
  }
  for (const field of QUOTE_LIST_FIELDS) {
    if (!Array.isArray(analysis[field])) continue;
    analysis[field].forEach((item, index) => {
      if (item && typeof item.quote === 'string' && item.quote.trim()) out.push({ field, index, quote: item.quote });
    });
  }
  const goal = analysis.persona && analysis.persona.goal_quote;
  if (typeof goal === 'string' && goal.trim()) out.push({ field: 'persona.goal', quote: goal });
  return out;
}

// Legacy readers listed these three first; order kept so existing audit
// output does not reshuffle.
const QUOTE_LIST_FIELDS = ['feature_requests', 'deal_breakers', 'trust_signals',
  'pain_points', 'expected_baseline', 'ethics_concerns', 'tools_mentioned'];

module.exports = { validateAnalysis, normalizeForMatch, parseSpeaker, quoteEntries, LIST_FIELDS, QUOTE_LIST_FIELDS };
