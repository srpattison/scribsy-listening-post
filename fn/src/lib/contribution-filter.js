'use strict';

// Source attribution, not recurrence: an item is excluded only when every
// matching source is filtered. Ambiguous human/bot matches remain for review.
// Raw archives and stored analysis are never mutated.
const { checkQuotes } = require('./quality-benchmark');
const { idFromRowKey, kindOf } = require('./rowkeys');

function filterContributions(row, raw, registry) {
  const checks = checkQuotes(row, raw, { registry, registryAvailable: true });
  const analysis = JSON.parse(row.analysisJson);
  const excluded = [], statuses = {};
  for (const check of checks) {
    statuses[check.status] = (statuses[check.status] || 0) + 1;
    if (check.status === 'short-ambiguous' || !check.matches.length ||
        !check.matches.every(match => match.filtered &&
          ['automod-author', 'distinguished', 'stickied'].includes(match.reason))) continue;
    excluded.push({ field: check.field, index: check.index, quoteHash: check.quoteHash,
      reasons: [...new Set(check.matches.map(match => match.reason))].sort() });
  }
  if (excluded.some(item => item.field === 'notable_quote')) analysis.notable_quote = '';
  for (const field of ['feature_requests', 'deal_breakers', 'trust_signals']) {
    const indices = new Set(excluded.filter(item => item.field === field).map(item => item.index));
    if (indices.size) analysis[field] = analysis[field].filter((_, index) => !indices.has(index));
  }
  return { row: { ...row, analysisJson: JSON.stringify(analysis) },
    audit: { quotes: checks.length, statuses, excluded } };
}

async function prepareContributions(rows, store, registry, { concurrency = 16 } = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error('Invalid source-read concurrency');
  const prepared = new Array(rows.length);
  const health = { version: 1, rows: rows.length, checkedRows: 0, unavailableRows: 0,
    quoteFields: 0, excluded: { count: 0, byField: {}, byReason: {} }, statuses: {}, degraded: false };
  let cursor = 0;
  const add = (map, key, n = 1) => { map[key] = (map[key] || 0) + n; };
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, async () => {
    while (cursor < rows.length) {
      const index = cursor++, row = rows[index];
      prepared[index] = row;
      let analysis;
      try { analysis = JSON.parse(row.analysisJson); } catch { continue; }
      if (!analysis?.notable_quote && !['feature_requests', 'deal_breakers', 'trust_signals']
        .some(field => Array.isArray(analysis?.[field]) && analysis[field].some(item => item?.quote))) continue;
      try {
        const raw = await store.getRaw(row.partitionKey, row.createdUtc, idFromRowKey(row.rowKey), kindOf(row));
        const result = filterContributions(row, raw, registry.get(String(row.partitionKey).toLowerCase()));
        prepared[index] = result.row;
        health.checkedRows++;
        health.quoteFields += result.audit.quotes;
        for (const [key, n] of Object.entries(result.audit.statuses)) add(health.statuses, key, n);
        for (const item of result.audit.excluded) {
          health.excluded.count++;
          add(health.excluded.byField, item.field);
          for (const reason of item.reasons) add(health.excluded.byReason, reason);
        }
      } catch {
        // No source text or credential-bearing error strings in public health.
        health.unavailableRows++;
      }
    }
  }));
  health.degraded = health.unavailableRows > 0;
  if (health.degraded) health.degradedReason = 'Contribution source checks are incomplete.';
  return { rows: prepared, health };
}

// Production preflight. Reject incomplete reads before writing ANY aggregate,
// preserving the last successful rollup. The engine also remains available as
// a pure aggregation entry point for same-input replay and unit tests.
async function runSourceCheckedRollup(options) {
  const startedMs = Date.now();
  const { store } = options;
  const rows = await store.listAnalyzedPosts();
  const registry = await require('./boilerplate-filter').loadRegistryForSubs(store, rows.map(row => row.partitionKey));
  const result = await prepareContributions(rows, store, registry);
  result.health.preflightDurationMs = Date.now() - startedMs;
  if (result.health.degraded) throw new Error(`Contribution preflight failed: ${result.health.unavailableRows} source rows unavailable; no aggregates written.`);
  return require('./rollup-engine').runRollup({ ...options, contributionHealth: result.health,
    store: { ...store, listAnalyzedPosts: async () => result.rows } });
}

module.exports = { filterContributions, prepareContributions, runSourceCheckedRollup };
