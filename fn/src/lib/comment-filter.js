'use strict';

// Prompt-side bot/boilerplate filtering (CB-LISTEN-REPO-6).
//
// REPO-5 detected boilerplate at tagging and rollup time, but the analyze path
// still handed `raw.comments` to the model unfiltered. Row-level tagging cannot
// reach the result: the parent post is correctly classified `human`, and the
// contamination sits inside its analysed output — verbatim quote fields lifted
// from a moderator sticky, and a comment_stance_mix that counted bot replies as
// community stances.
//
// WHY THIS IS NOT JUST A CALL-SITE FILTER. Only three of REPO-5's detectors are
// computable from a single comment in isolation: author, distinguished,
// stickied. Repeat-hash asks "does this normalised text recur ≥N times within
// this subreddit", which is corpus-level knowledge a single analyzePost
// invocation does not have. Shipping only the isolation-computable signals
// would quietly demote repeat-hash from primary detector to absent — the same
// "secondary signal doing all the work" failure REPO-5's acceptance checks were
// written to prevent, one layer down.
//
// So the corpus-level detector gets somewhere to live: a persisted registry of
// boilerplate hashes per subreddit (see lib/boilerplate-registry.js), written
// by retag and rollup, read here.
//
// FILTER, NEVER DELETE. `raw` blobs stay complete — the archive is the only
// path to remediation.

const cc = require('./content-class');

// CB-LISTEN-FIX-1 F1. Moderator and bot units reached the model because the
// only role signals were a literal `AutoModerator` author and
// `distinguished === 'moderator'` — and context comments are archived as
// { id, author, score, body } with no `distinguished` or `stickied` at all, so
// those detectors could never fire on them. A subreddit's `<sub>-ModTeam`
// account (the removal/rule-note sender) matched nothing.
//
// Role is now derived from the author name as well as from Reddit's own flags.
// An explicit `roleHint` on a unit (review packets carry one) is honoured.
const EXCLUDED_ROLES = new Set(['mod-team-account', 'automoderator', 'moderator']);
const EXCLUDED_DISTINGUISHED = new Set(['moderator', 'admin']);
const MOD_TEAM_AUTHOR = /(^|[-_])modteam$/i;

function roleHintOf(unit) {
  if (!unit || typeof unit !== 'object') return 'ordinary-or-unknown';
  const hint = String(unit.roleHint || '').toLowerCase();
  if (EXCLUDED_ROLES.has(hint)) return hint;
  const author = String(unit.author || '').toLowerCase();
  if (cc.KNOWN_BOT_AUTHORS.has(author)) return 'automoderator';
  if (MOD_TEAM_AUTHOR.test(author)) return 'mod-team-account';
  return 'ordinary-or-unknown';
}

// Registered boilerplate fingerprints are hashes of normalised SENTENCES, not
// of whole bodies, so a mod template pasted by an ordinary account is caught
// even when a genuine sentence is added to it — and only the template part is
// removed. Registration is explicit (config), never inferred from repetition:
// two writers saying the same thing are two data points.
const MIN_SENTENCE_CHARS = 20;

function sentencesOf(text) {
  return String(text || '').split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
}

function sentenceHash(sentence) {
  const n = cc.normalizeText(sentence);
  return n.length >= MIN_SENTENCE_CHARS ? cc.hashText(n) : null;
}

// Fingerprints for a template text, for registering in BOILERPLATE_FINGERPRINTS.
function fingerprintsOf(text) {
  return [...new Set(sentencesOf(text).map(sentenceHash).filter(Boolean))];
}

// → { all: true } when every hashable sentence is registered boilerplate;
//   { residual } when some are, with the registered sentences removed;
//   null when nothing matches.
function matchFingerprints(text, fingerprints) {
  if (!fingerprints || !fingerprints.size) return null;
  const sentences = sentencesOf(text);
  let hashable = 0, matched = 0;
  const residual = [];
  for (const s of sentences) {
    const h = sentenceHash(s);
    if (h) hashable++;
    if (h && fingerprints.has(h)) matched++;
    else residual.push(s);
  }
  if (!matched) return null;
  if (matched === hashable) return { all: true };
  return { residual: residual.join(' ') };
}

// Classify a single comment. `registry` is a Set of normalised hashes known to
// be boilerplate in this comment's subreddit; absent or empty is fine, the
// per-row signals still apply. `modBotAuthors` and `fingerprints` are the
// configured lists (config.modBotAuthors / config.boilerplateFingerprints).
function classifyComment(comment, {
  registry = null, minChars = cc.DEFAULT_MIN_CHARS, modBotAuthors = null, fingerprints = null
} = {}) {
  const author = String((comment && comment.author) || '').toLowerCase();
  if (cc.KNOWN_BOT_AUTHORS.has(author)) return { keep: false, reason: 'automod-author' };
  const role = roleHintOf(comment);
  if (EXCLUDED_ROLES.has(role)) return { keep: false, reason: `role-${role}` };
  if (EXCLUDED_DISTINGUISHED.has(String((comment && comment.distinguished) || '').toLowerCase())) {
    return { keep: false, reason: 'distinguished' };
  }
  if (author && modBotAuthors && modBotAuthors.has(author)) return { keep: false, reason: 'mod-bot-list' };
  if (comment && comment.stickied === true) return { keep: false, reason: 'stickied' };
  if (registry && registry.size) {
    const hash = cc.hashIfEligible((comment && comment.body) || '', minChars);
    if (hash && registry.has(hash)) return { keep: false, reason: 'registry-hash' };
  }
  const fp = matchFingerprints((comment && comment.body) || '', fingerprints);
  if (fp && fp.all) return { keep: false, reason: 'boilerplate-fingerprint' };
  if (fp) return { keep: true, reason: null, strippedBody: fp.residual };
  return { keep: true, reason: null };
}

// Split comments into what reaches the prompt and what does not.
//
// Returns { kept, filtered, reasons } where `reasons` counts by detector, so
// production can tell "filtering works" from "no bot comments were present" —
// which are indistinguishable from the outside, and the second is what a broken
// filter looks like (§3c). A comment that keeps a genuine sentence around a
// registered template is kept with the template removed and counted in
// `strippedCount`, not in `filteredCount`.
function filterComments(comments, opts = {}) {
  const kept = [];
  const filtered = [];
  const reasons = {};
  let strippedCount = 0;
  for (const c of comments || []) {
    const { keep, reason, strippedBody } = classifyComment(c, opts);
    if (keep && strippedBody !== undefined) {
      kept.push({ ...c, body: strippedBody });
      strippedCount++;
    } else if (keep) {
      kept.push(c);
    } else {
      filtered.push({ ...c, filterReason: reason });
      reasons[reason] = (reasons[reason] || 0) + 1;
    }
  }
  return { kept, filtered, reasons, filteredCount: filtered.length, strippedCount };
}

// The submission itself is a unit too: an AutoModerator or ModTeam post is not
// writer text and is not sent to the model. Repetition-derived signals
// (registry-hash) and `stickied` are deliberately NOT applied to posts here —
// a stickied human post and a recurring megathread title are the rollup's
// content-class question, unchanged by this round.
const POST_EXCLUDING_REASONS = new Set([
  'automod-author', 'role-mod-team-account', 'role-automoderator', 'role-moderator',
  'distinguished', 'mod-bot-list', 'boilerplate-fingerprint'
]);

function classifyPost(post, { modBotAuthors = null, fingerprints = null } = {}) {
  const r = classifyComment({ ...(post || {}), body: (post && post.selftext) || '' }, { modBotAuthors, fingerprints });
  return POST_EXCLUDING_REASONS.has(r.reason) ? { keep: false, reason: r.reason } : { keep: true, reason: null };
}

module.exports = {
  classifyComment, filterComments, classifyPost, roleHintOf, fingerprintsOf, matchFingerprints,
  EXCLUDED_ROLES
};
