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

// Classify a single comment. `registry` is a Set of normalised hashes known to
// be boilerplate in this comment's subreddit; absent or empty is fine, the
// per-row signals still apply.
function classifyComment(comment, { registry = null, minChars = cc.DEFAULT_MIN_CHARS } = {}) {
  const author = String((comment && comment.author) || '').toLowerCase();
  if (cc.KNOWN_BOT_AUTHORS.has(author)) return { keep: false, reason: 'automod-author' };
  if (String((comment && comment.distinguished) || '').toLowerCase() === 'moderator') {
    return { keep: false, reason: 'distinguished' };
  }
  if (comment && comment.stickied === true) return { keep: false, reason: 'stickied' };
  if (registry && registry.size) {
    const hash = cc.hashIfEligible((comment && comment.body) || '', minChars);
    if (hash && registry.has(hash)) return { keep: false, reason: 'registry-hash' };
  }
  return { keep: true, reason: null };
}

// Split comments into what reaches the prompt and what does not.
//
// Returns { kept, filtered, reasons } where `reasons` counts by detector, so
// production can tell "filtering works" from "no bot comments were present" —
// which are indistinguishable from the outside, and the second is what a broken
// filter looks like (§3c).
function filterComments(comments, opts = {}) {
  const kept = [];
  const filtered = [];
  const reasons = {};
  for (const c of comments || []) {
    const { keep, reason } = classifyComment(c, opts);
    if (keep) {
      kept.push(c);
    } else {
      filtered.push({ ...c, filterReason: reason });
      reasons[reason] = (reasons[reason] || 0) + 1;
    }
  }
  return { kept, filtered, reasons, filteredCount: filtered.length };
}

module.exports = { classifyComment, filterComments };
