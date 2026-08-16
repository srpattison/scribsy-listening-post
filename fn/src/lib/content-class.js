'use strict';

// Bot / boilerplate detection (CB-LISTEN-REPO-5).
//
// AutoModerator megathreads run on a schedule, so a 12-month backfill captures
// dozens of byte-identical copies per sub, each carrying the subreddit's rule
// text in its body. A frequency-weighted aggregate reads that as writer
// sentiment — and because the repetition is systematic rather than random, it
// biases the corpus toward appearing anti-AI. That corrupts precisely the
// questions this system exists to answer.
//
// DESIGN: the primary detector is general. Hardcoding "AutoModerator" catches
// one bot; writing subs also carry critique-thread bots, removal notices,
// RemindMeBot, and submission templates the subreddit itself injects into post
// bodies with no bot author at all. So the primary signal is repeat-hash —
// identical normalised text recurring within one subreddit — which costs
// nothing per row, needs no model call, and catches bots nobody enumerated.
// Author / distinguished / stickied are cheap high-precision signals layered
// on top.
//
// Rows are TAGGED, never deleted. Deletion is irreversible, and the rule text
// is genuinely useful as its own signal: what a subreddit formally prohibits is
// real evidence about community norms. It simply is not sentiment.

const crypto = require('node:crypto');

const CLASS_HUMAN = 'human';
const CLASS_BOT = 'bot';
const CLASS_BOILERPLATE = 'boilerplate';

// Repeat-hash only applies to text at least this long once normalised.
//
// THE FALSE-POSITIVE GUARD. Short phrases genuinely recur between different
// writers — "good luck with your draft" normalises to 25 characters and would
// be flagged in any active sub within a week. Subreddit rule text, megathread
// bodies and submission templates run to several hundred characters. 120 sits
// well above ordinary human phrasing and well below real boilerplate.
const DEFAULT_MIN_CHARS = 120;

// Titles get a lower floor, and the difference is principled rather than a
// fudge: bodies are prose, where ordinary phrasing genuinely recurs, whereas a
// byte-identical TITLE repeated within one sub is a structural signal. Writers
// do not independently produce the same 40+ character headline; scheduled
// threads do, every week. "Able to beta? Post here! Weekly beta reader matching
// thread" normalises to 85 characters — real boilerplate, but under the body
// floor, so without this it would go undetected wherever the author signal is
// absent. Ordinary short titles ("Looking for beta readers", 24 chars) stay
// below it.
const DEFAULT_MIN_TITLE_CHARS = 40;

// Verbatim repeats within one subreddit before text is considered boilerplate.
const DEFAULT_MIN_REPEATS = 5;

const KNOWN_BOT_AUTHORS = new Set(['automoderator']);

// Lowercase, strip URLs and markdown, collapse whitespace. Deliberately lossy:
// two megathread copies differing only by a date stamp should still collide.
function normalizeText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/```[\s\S]*?```/g, ' ')          // fenced code
    .replace(/https?:\/\/\S+/g, ' ')          // urls
    .replace(/&[a-z]{2,8};/g, ' ')            // html entities
    .replace(/[*_~`>#|]+/g, ' ')              // markdown emphasis / quotes / tables
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')  // markdown links → label
    .replace(/\d{1,4}([-/]\d{1,4}){1,2}/g, ' ') // date stamps
    .replace(/\s+/g, ' ')
    .trim();
}

const hashText = (normalized) =>
  crypto.createHash('sha1').update(normalized, 'utf8').digest('hex').slice(0, 16);

// Eligible text: long enough that verbatim recurrence is not ordinary phrasing.
function hashIfEligible(text, minChars = DEFAULT_MIN_CHARS) {
  const n = normalizeText(text);
  if (n.length < minChars) return null;
  return hashText(n);
}

// Count verbatim repeats per (subreddit, hash). Titles and bodies are hashed
// INDEPENDENTLY — the megathreads repeat both, and a shared body with varying
// titles is just as much boilerplate as the reverse.
//
// `rows` need only expose { subreddit, title, body }.
function buildRepeatIndex(rows, { minChars = DEFAULT_MIN_CHARS, minTitleChars = DEFAULT_MIN_TITLE_CHARS } = {}) {
  const titles = new Map();
  const bodies = new Map();
  const bump = (map, sub, hash) => {
    if (!hash) return;
    const key = `${String(sub || '').toLowerCase()}|${hash}`;
    map.set(key, (map.get(key) || 0) + 1);
  };
  for (const r of rows || []) {
    bump(titles, r.subreddit, hashIfEligible(r.title, minTitleChars));
    bump(bodies, r.subreddit, hashIfEligible(r.body, minChars));
  }
  return { titles, bodies, minChars, minTitleChars };
}

const repeatsFor = (index, kind, sub, hash) =>
  (hash ? index[kind].get(`${String(sub || '').toLowerCase()}|${hash}`) || 0 : 0);

// Classify one row. Precedence runs most-certain first; `bot` outranks
// `boilerplate` because an identified bot author is a stronger statement than
// "this text recurs".
//
// Returns { contentClass, contentClassReason }.
function classifyRow(row, index, { minRepeats = DEFAULT_MIN_REPEATS, minChars = DEFAULT_MIN_CHARS, minTitleChars = DEFAULT_MIN_TITLE_CHARS } = {}) {
  const author = String(row.author || '').toLowerCase();
  if (KNOWN_BOT_AUTHORS.has(author)) {
    return { contentClass: CLASS_BOT, contentClassReason: 'automod-author' };
  }
  if (String(row.distinguished || '').toLowerCase() === 'moderator') {
    return { contentClass: CLASS_BOT, contentClassReason: 'distinguished' };
  }
  if (row.stickied === true) {
    return { contentClass: CLASS_BOILERPLATE, contentClassReason: 'stickied' };
  }
  if (index) {
    const titleHash = hashIfEligible(row.title, minTitleChars);
    const bodyHash = hashIfEligible(row.body, minChars);
    if (repeatsFor(index, 'titles', row.subreddit, titleHash) > minRepeats ||
        repeatsFor(index, 'bodies', row.subreddit, bodyHash) > minRepeats) {
      return { contentClass: CLASS_BOILERPLATE, contentClassReason: 'repeat-hash' };
    }
  }
  return { contentClass: CLASS_HUMAN, contentClassReason: '' };
}

// Classify a whole corpus in one pass: build the index, then label each row.
function classifyCorpus(rows, opts = {}) {
  const index = buildRepeatIndex(rows, opts);
  return (rows || []).map((r) => ({ ...r, ...classifyRow(r, index, opts) }));
}

const isHuman = (row) => (row && row.contentClass ? row.contentClass : CLASS_HUMAN) === CLASS_HUMAN;

module.exports = {
  CLASS_HUMAN,
  CLASS_BOT,
  CLASS_BOILERPLATE,
  DEFAULT_MIN_CHARS,
  DEFAULT_MIN_TITLE_CHARS,
  DEFAULT_MIN_REPEATS,
  KNOWN_BOT_AUTHORS,
  normalizeText,
  hashText,
  hashIfEligible,
  buildRepeatIndex,
  classifyRow,
  classifyCorpus,
  isHuman
};
