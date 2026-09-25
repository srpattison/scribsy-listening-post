'use strict';

// The two deterministic steps around every analysis model call
// (CB-LISTEN-FIX-1 F1/F4), shared by the live analyze worker and the metered
// replay (scripts/quality-pilot.js) so a replay measures the pipeline that
// ships, not an older one (CB-LISTEN-FIX-1b R2).
//
//   excludeUnits → decide what the model may see (before any spend)
//   groundOutput → drop and count items not grounded in what it saw

const config = require('./config');
const { filterComments, classifyPost } = require('./comment-filter');
const { validateAnalysis } = require('./grounding-validator');

// `registry` is the per-sub Set of repeat hashes; the configured lists default
// to the live app settings.
function excludeUnits(raw, {
  registry = new Set(),
  minChars = config.boilerplateMinCharsBody(),
  modBotAuthors = config.modBotAuthors(),
  fingerprints = config.boilerplateFingerprints()
} = {}) {
  const post = classifyPost(raw.post, { modBotAuthors, fingerprints });
  const { kept, reasons, filteredCount, strippedCount } =
    filterComments(raw.comments || [], { registry, minChars, modBotAuthors, fingerprints });
  return {
    postExcluded: !post.keep,
    postReason: post.reason,
    promptComments: kept,
    filterReasons: reasons,
    filteredCount,
    strippedCount,
    // What the row records: partial template removals are not exclusions,
    // but are counted beside them.
    auditReasons: strippedCount ? { ...reasons, 'boilerplate-fingerprint-partial': strippedCount } : reasons
  };
}

// Returns a new analysis object carrying `grounding` = { checked, drops, dropReasons }.
function groundOutput(modelOutput, post, promptComments) {
  const grounding = validateAnalysis(modelOutput, { post, comments: promptComments });
  const analysis = grounding.analysis;
  analysis.grounding = { checked: grounding.checked, drops: grounding.drops, dropReasons: grounding.dropReasons };
  return analysis;
}

module.exports = { excludeUnits, groundOutput };
