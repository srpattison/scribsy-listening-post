'use strict';

// Read-only benchmark primitives. Sampling is balanced across observed strata,
// NOT a prevalence estimator. Quote matching establishes text origin only.
const { createHash } = require('node:crypto');
const { kindOf } = require('./rowkeys');
const { classifyComment } = require('./comment-filter');
const digest = text => createHash('sha256').update(String(text)).digest('hex');
const identity = row => `${row.partitionKey}|${row.rowKey}`;
const normalize = text => String(text || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

function stratum(row) {
  const date = new Date(Number(row.createdUtc) * 1000);
  const month = Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 7) : 'unknown-date';
  return [row.source || 'reddit', row.partitionKey, kindOf(row), month,
    row.analysisPromptVersion || 'unstamped'].join('|');
}

function selectSample(rows, limit = 120, seed = 'LP-QUALITY-1') {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('Positive integer sample limit required');
  const groups = new Map(), seen = new Set();
  for (const row of rows) {
    const id = identity(row);
    if (!row.partitionKey || !row.rowKey) throw new Error('Stable row identity required');
    if (seen.has(id)) throw new Error('Duplicate row identity in snapshot');
    seen.add(id);
    const key = stratum(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ row, rank: digest(`${seed}|${id}`) });
  }
  const keys = [...groups.keys()].sort((a,b) => digest(`${seed}|${a}`).localeCompare(digest(`${seed}|${b}`)) || a.localeCompare(b));
  for (const group of groups.values()) group.sort((a,b) => a.rank.localeCompare(b.rank));
  const selected = [];
  for (let round = 0; selected.length < Math.min(limit, rows.length); round++) {
    for (const key of keys) {
      const item = groups.get(key)[round];
      if (item) selected.push(item.row);
      if (selected.length === Math.min(limit, rows.length)) break;
    }
  }
  const selectedCounts = {};
  for (const row of selected) selectedCounts[stratum(row)] = (selectedCounts[stratum(row)] || 0) + 1;
  return { selected, manifest: { version: 1, seed, population: rows.length, selected: selected.length,
    selectionHash: digest(selected.map(identity).join('\n')), strata: keys.map(key => ({ key, population: groups.get(key).length, selected: selectedCounts[key] || 0 })),
    limitation: 'Balanced diagnostic sample; not population-weighted. Uncovered strata are explicit.' } };
}

function analysisQuotes(row) {
  const a = JSON.parse(row.analysisJson);
  const out = [];
  if (typeof a.notable_quote === 'string' && a.notable_quote.trim()) out.push({ field: 'notable_quote', quote: a.notable_quote });
  for (const field of ['feature_requests','deal_breakers','trust_signals']) {
    if (!Array.isArray(a[field])) continue;
    a[field].forEach((item,index) => {
      if (typeof item?.quote === 'string' && item.quote.trim()) out.push({ field, index, quote:item.quote });
    });
  }
  return out;
}

function checkQuotes(row, raw, { registry = null, registryAvailable = false } = {}) {
  const quotes = analysisQuotes(row);
  const own = raw?.post;
  if (!own || typeof own !== 'object') throw new Error('Source blob lacks post object');
  const ownClass = classifyComment({ ...own, body: own.selftext || '' }, { registry });
  const sources = [{ origin: kindOf(row) === 'comment' ? 'own-comment' : 'own-post',
    texts: [own.title, own.selftext], filtered: !ownClass.keep, reason: ownClass.reason }];
  for (const [index,comment] of (raw.comments || []).entries()) {
    const result = classifyComment(comment, { registry });
    sources.push({ origin: 'context-comment', index, texts:[comment.body], filtered:!result.keep, reason:result.reason });
  }
  return quotes.map(({field,index,quote}) => {
    const text = normalize(quote);
    const matches = sources.filter(source => source.texts.some(part => normalize(part).includes(text)))
      .map(({texts,...source}) => source);
    let status = 'not-verified';
    if (text.length < 20) status = 'short-ambiguous';
    else if (matches.length > 1) status = 'multiple-origins';
    else if (matches.length === 1) status = matches[0].filtered ? 'filtered-source-only' : 'single-origin';
    return { field, index, quote, quoteHash:digest(text), status, matches, registryAvailable,
      semanticVerdict:'unreviewed' };
  });
}

// Enriched recurrence challenges are kept separate from the diagnostic sample.
// Repeated text is a candidate for review, never a boilerplate verdict.
function recurrenceChallenges(rows, limit = 20) {
  const groups = new Map();
  for (const row of rows) {
    let quotes; try { quotes = analysisQuotes(row); } catch { continue; }
    for (const q of quotes.filter(q => ['feature_requests','notable_quote'].includes(q.field))) {
      const n = normalize(q.quote); if (n.length < 20) continue;
      const key = `${row.partitionKey}|${digest(n)}`;
      if (!groups.has(key)) groups.set(key, new Map());
      groups.get(key).set(identity(row), row);
    }
  }
  return [...groups.entries()].filter(([,g]) => g.size > 5)
    .sort((a,b) => b[1].size-a[1].size || a[0].localeCompare(b[0])).slice(0,limit)
    .map(([key,g]) => ({ key, occurrences:g.size, row:[...g.values()].sort((a,b)=>identity(a).localeCompare(identity(b)))[0] }));
}

function summarize(records) {
  const result = { rows:records.length, rawAvailable:0, rawUnavailable:0, analysisErrors:0, quotes:0, statuses:{}, fields:{}, registryUnavailableRows:0,
    semanticReview:'not performed; origin checks do not validate intent, stance, or topic labels' };
  for (const record of records) {
    if (record.error) { result[record.error === 'analysis' ? 'analysisErrors' : 'rawUnavailable']++; continue; }
    result.rawAvailable++;
    if (!record.registryAvailable) result.registryUnavailableRows++;
    for (const q of record.checks) {
      result.quotes++;
      result.statuses[q.status] = (result.statuses[q.status] || 0) + 1;
      result.fields[q.field] = (result.fields[q.field] || 0) + 1;
    }
  }
  return result;
}

module.exports = { digest, identity, normalize, stratum, selectSample, analysisQuotes, checkQuotes, recurrenceChallenges, summarize };
