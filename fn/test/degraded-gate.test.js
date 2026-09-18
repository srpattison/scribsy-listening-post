'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { runRollup } = require('../src/lib/rollup-engine');
const gate = require('../src/lib/evidence-gate');
const env = { SUBREDDITS: 'writing', SUB_TAGS: '{}', BSKY_STREAMS: '[]' };
const oldAnswers = [{ question: 'What should we build?', answer: 'UNSAFE CLAIM', confidence: 'high', evidence: ['AUTOMOD QUOTE'] }];

async function rollup({ degraded = false, registryFails = false, synthesisFails = false } = {}) {
  const saved = new Map([['brief', { answers: oldAnswers }]]);
  const calls = [];
  let previousBriefReads = 0;
  const store = {
    listAnalyzedPosts: async () => [{ partitionKey: 'writing', rowKey: 'p1', author: 'writer', permalink: '/p1',
      analysisJson: JSON.stringify({ ai_related: true, week: '2026-W37', summary: 'writer need',
        feature_requests: [{ feature: 'feedback', ai_related: false, quote: 'AUTOMOD QUOTE' }], notable_quote: 'AUTOMOD QUOTE' }) }],
    saveAggregate: async (p, _k, v) => saved.set(p, v),
    getAggregate: async (p) => {
      if (p === 'brief') previousBriefReads++;
      if (p === 'boilerplate-registry' && registryFails) throw new Error('registry offline');
      return saved.get(p) || null;
    }
  };
  const aoai = {
    normalizeFeatures: async () => { if (degraded) throw new Error('AOAI returned empty content'); return { groups: [{ canonical: 'feedback', members: [0] }] }; },
    synthesizePersonas: async () => ({ personas: [{ name: 'Synthetic persona', archetype: 'curious', stance: 'curious', share_pct: 75, goals: 'Invented joint need', representative_quote: 'Model-generated quote' }] }),
    standingQuestions: () => ['custom question with unknown dependencies'],
    strategyBrief: async (evidence) => { calls.push(evidence); if (synthesisFails) throw new Error('synthesis offline'); return { answers: oldAnswers }; }
  };
  const summary = await runRollup({ store, aoai, env, context: {}, now: () => new Date('2026-09-17T12:00:00Z') });
  return { saved, calls, previousBriefReads, summary };
}

test('normalization failure blocks the real synthesis boundary, including alternate quotes and cached answers', async () => {
  const r = await rollup({ degraded: true });
  assert.equal(r.calls.length, 0, 'neither featureBoard nor sampleQuotes may enter synthesis');
  assert.equal(r.previousBriefReads, 0);
  assert.deepEqual(r.saved.get('brief-candidate').answers, []);
  assert.equal(r.summary.briefEvidenceGate.status, 'blocked');
  assert.ok(r.saved.get('brief-candidate').evidenceGate.blockedBy.some(b => b.section === 'features' && b.kind === 'cannot-execute'));
  assert.ok(r.saved.get('features').featureBoard.length, 'diagnostic fallback retained in storage');
  assert.ok(r.saved.has('snapshot'), 'unrelated sections still finish');
});

test('healthy synthesis stages its answers and preserves the previous publication', async () => {
  const r = await rollup();
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].featureBoard.length, 1);
  assert.equal(r.calls[0].featureScope.clusteredNames, 1);
  assert.equal(r.calls[0].featureScope.totalNames, 1);
  assert.match(r.calls[0].featureScope.note, /not population-weighted/);
  assert.equal(r.calls[0].corpusScope.humanRows, 1);
  assert.match(r.calls[0].corpusScope.units, /not distinct posts or people/);
  assert.match(r.calls[0].cohortScope.units, /NOT a denominator/);
  assert.equal(r.calls[0].sampleQuotes.length, 0);
  assert.equal(r.calls[0].evidenceQuality.confidenceCeiling, 'low');
  assert.match(r.calls[0].personaScope.note, /No measured joint indicator/);
  assert.equal(r.calls[0].personas.length, 1);
  assert.equal(r.calls[0].personas[0].archetype, 'curious');
  assert.ok(r.calls[0].personas.every(p => !('share_pct' in p) && !('goals' in p)));
  assert.equal(r.saved.get('brief-candidate').evidenceGate.status, 'pass');
  assert.deepEqual(gate.publishBrief(r.saved.get('brief-candidate'), Object.fromEntries(r.saved), { degraded: false }).answers, []);
  assert.deepEqual(r.saved.get('brief'), { answers: oldAnswers });
  assert.equal(r.summary.briefPublication.status, 'review-required');
});

test('registry failure is cannot-execute and cannot silently feed synthesis', async () => {
  const r = await rollup({ registryFails: true });
  assert.equal(r.calls.length, 0);
  assert.equal(r.summary.briefEvidenceGate.status, 'blocked');
  assert.equal(r.saved.get('brief-candidate').evidenceGate.blockedBy[0].section, 'boilerplateRegistry');
});

test('a synthesis outage cannot resurrect an unstamped pre-fix brief', async () => {
  const r = await rollup({ synthesisFails: true });
  assert.deepEqual(r.saved.get('brief-candidate').answers, []);
});

test('missing, stale, degraded, truncated and real source errors remain distinguishable', () => {
  const healthy = Object.fromEntries(gate.DEPENDENCIES.map(s => [s, { items: [] }]));
  assert.equal(gate.evaluate(healthy, { degraded: false }).status, 'pass');
  for (const value of [undefined, {}, { _stale: true }, { degraded: true }, { _truncated: ['quotes'] }]) {
    const result = gate.evaluate({ ...healthy, features: value }, { degraded: false });
    assert.equal(result.status, 'blocked');
    assert.equal(result.blockedBy[0].kind, 'cannot-execute');
  }
  assert.equal(gate.evaluate({ ...healthy, features: { error: 'actual computation failed' } }, { degraded: false }).blockedBy[0].kind, 'source-error');
});

// Execute the actual registered HTTP handler, replacing only external deps.
function insightsHandler(saved, readFailure) {
  const file = path.join(__dirname, '../src/functions/api.js');
  const realRequire = createRequire(file);
  const routes = {};
  const store = {
    getAggregate: async p => { if (p === readFailure) throw new Error('read unavailable'); return saved.get(p) || null; },
    countPosts: async () => ({}), queueDepth: async () => 0,
    listAggregates: async () => []
  };
  const requireStub = id => {
    if (id === '@azure/functions') return { app: { http: (name, route) => { routes[name] = route; } } };
    if (id === '../lib/store') return store;
    if (id === '../lib/boilerplate-registry') return { summarize: async () => ({}) };
    if (id === '../lib/backfill-sweep') return { orphanHealthBlock: async () => ({}) };
    if (id === '../lib/analysis-provenance') return { provenanceHealthBlock: () => ({}), filterVersion: () => 'fixture' };
    if (id === '../lib/aoai') return { analysisPromptVersion: () => 'fixture', deploymentInForce: () => 'fixture' };
    return realRequire(id);
  };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { require: requireStub, URL, process, Buffer, console, module: { exports: {} } }, { filename: file });
  return view => routes.insights.handler({ url: 'https://fixture/api/insights?view=' + view });
}

test('actual insights all/brief/features routes contain old stored data before another rollup', async () => {
  const r = await rollup();
  r.saved.set('features', { featureBoard: [{ feature: 'UNSAFE CLAIM', examples: ['AUTOMOD QUOTE'] }], degraded: true });
  const handler = insightsHandler(r.saved);
  for (const view of ['all', 'brief', 'features']) {
    const response = await handler(view);
    assert.equal(response.headers['Cache-Control'], 'no-store');
    assert.ok(!JSON.stringify(response.jsonBody).includes('UNSAFE CLAIM'));
    assert.equal((view === 'all' ? response.jsonBody.brief : response.jsonBody).evidenceGate.status, 'blocked');
  }
});

test('actual insights route suppresses legacy briefs, fails closed on read error, and allows healthy receipt', async () => {
  const r = await rollup();
  const candidate = r.saved.get('brief-candidate');
  candidate.editorialReview = { version: 1, status: 'approved', reviewer: 'test reviewer', reviewedAt: '2026-09-18T00:00:00Z', contentHash: require('../src/lib/brief-review').contentHash(candidate) };
  r.saved.set('brief', candidate);
  assert.equal((await insightsHandler(r.saved)('brief')).jsonBody.answers.length, 1);
  assert.equal((await insightsHandler(r.saved, 'features')('brief')).jsonBody.answers.length, 0);
  r.saved.set('brief', { answers: oldAnswers });
  assert.equal((await insightsHandler(r.saved)('brief')).jsonBody.answers.length, 0);
});

test('dashboard clears old feature counts/answers and distinguishes degraded from failed', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../swa/index.html'), 'utf8');
  const code = html.slice(html.indexOf('function sectionProblem('), html.indexOf('function renderHealthBar('));
  const elements = { '#brief': { innerHTML: 'UNSAFE CLAIM' }, '#featuresAi': { innerHTML: '695' }, '#features': { innerHTML: 'AUTOMOD QUOTE' } };
  const sandbox = { $: sel => elements[sel], esc: s => String(s).replaceAll('<', '&lt;') };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  let renders = 0;
  sandbox.section('features', ['#featuresAi', '#features'], { degraded: true, degradedReason: 'provider unavailable' }, () => renders++);
  sandbox.section('brief', ['#brief'], { unavailable: true }, () => renders++);
  assert.equal(renders, 0);
  assert.match(elements['#brief'].innerHTML, /evidence degraded/);
  assert.match(elements['#featuresAi'].innerHTML, /provider unavailable/);
  assert.equal(elements['#features'].innerHTML, '');
  sandbox.section('brief', ['#brief'], { error: 'computation failed' }, () => renders++);
  assert.match(elements['#brief'].innerHTML, /rollup failed/);
  sandbox.section('brief', ['#brief'], { answers: [] }, () => renders++);
  assert.equal(renders, 1);
});
