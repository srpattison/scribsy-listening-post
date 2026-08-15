'use strict';

// Comment analysis policy (CB-LISTEN-REPO-4 §3b).
//
// Ingest and analysis are DECOUPLED. Comments are fetched and archived to `raw`
// unconditionally — the archive window is the perishable resource and a missed
// archive may not be re-fetchable. Analysis is gated, because comment volume in
// active discussion subs runs 10–40× submissions and that ratio is unmeasured.
//
// SHIPPED DEFAULT IS `ingest-only`: zero comment analysis runs until the setting
// is explicitly changed. At ~$0.0075–$0.0125 per analyzed item, the unmeasured
// ratio swings the comment line item between roughly $200 and $1,600 against a
// $3,000 ceiling. Measuring is cheap; guessing is not.
//
// The same predicate powers the live gate and the dry run, so the reported
// selected-fraction is a real evaluation of the policy — not an estimate of it.

const { mentionsAi } = require('./taxonomy');

// A comment qualifies when its parent submission is AI-related, OR when it is
// substantial enough to be worth reading AND mentions AI at all.
function qualifies(comment, { parentAiRelated = false, minChars = 400 } = {}) {
  if (parentAiRelated) return { selected: true, reason: 'parent-ai-related' };
  const chars = comment.bodyChars ?? String(comment.body || '').length;
  const hit = comment.aiPrefilterHit !== undefined
    ? !!comment.aiPrefilterHit
    : mentionsAi(comment.body);
  if (chars >= minChars && hit) return { selected: true, reason: 'long-and-ai-mentioning' };
  return {
    selected: false,
    reason: chars < minChars ? 'too-short' : 'no-ai-mention'
  };
}

// Should this comment be analyzed right now, under the live policy?
function shouldAnalyze(comment, { policy, parentAiRelated, minChars }) {
  if (policy === 'ingest-only') return { selected: false, reason: 'ingest-only' };
  if (policy === 'all') return { selected: true, reason: 'policy-all' };
  return qualifies(comment, { parentAiRelated, minChars });
}

// Dry run: evaluate the predicate over already-ingested comment rows WITHOUT
// issuing a single analysis call. `triage` rows carry only bodyChars,
// aiPrefilterHit and linkId — no bodies are read.
//
// Returns the counted figure, never an estimate.
function dryRun(triage, aiFlagsByPostId, { minChars = 400 } = {}) {
  const reasons = {};
  let selected = 0;
  for (const row of triage) {
    const parentAiRelated = row.linkId ? aiFlagsByPostId.get(row.linkId) === true : false;
    const r = qualifies(row, { parentAiRelated, minChars });
    reasons[r.reason] = (reasons[r.reason] || 0) + 1;
    if (r.selected) selected++;
  }
  const total = triage.length;
  return {
    comments: total,
    wouldSelect: selected,
    wouldSelectFraction: total ? selected / total : 0,
    byReason: reasons,
    minChars,
    note: 'Counted by evaluating the live policy predicate over ingested comment rows. No analysis calls were issued.'
  };
}

module.exports = { qualifies, shouldAnalyze, dryRun };
