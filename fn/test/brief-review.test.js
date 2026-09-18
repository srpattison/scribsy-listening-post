'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const review = require('../src/lib/brief-review');
const gate = require('../src/lib/evidence-gate');

const evidence = Object.fromEntries(gate.DEPENDENCIES.map(key => [key, { items: [] }]));
function approved() {
  const brief = { answers: [{ question: 'Scope?', answer: 'Selected rows only.', confidence: 'low' }],
    questions: ['Scope?'], generatedAt: '2026-09-18T04:24:00Z', evidenceGate: gate.evaluate(evidence, { degraded: false }) };
  brief.editorialReview = { version: 1, status: 'approved', reviewer: 'attended editorial review',
    reviewedAt: '2026-09-18T04:28:00Z', contentHash: review.contentHash(brief) };
  return brief;
}

test('exact reviewed artifact is publishable; dates or an old stamp alone are insufficient', () => {
  const brief = approved();
  assert.equal(gate.publishBrief(brief, evidence, { degraded: false }).answers.length, 1);
  for (const mutate of [
    b => { delete b.editorialReview; },
    b => { b.editorialReview = { reviewedAt: '2026-09-18T04:28:00Z' }; },
    b => { b.answers[0].answer = 'Most writers demand this.'; },
    b => { b.answers[0].confidence = 'high'; },
    b => { b.generatedAt = '2026-09-19T13:00:00Z'; },
    b => { b.questions.push('Unreviewed question'); }
  ]) {
    const copy = structuredClone(brief); mutate(copy);
    assert.equal(gate.publishBrief(copy, evidence, { degraded: false }).answers.length, 0);
  }
});

test('storage property order cannot invalidate a review; fresh evidence degradation still blocks it', () => {
  const brief = approved();
  const reordered = Object.fromEntries(Object.entries(brief).reverse());
  assert.equal(review.isReviewed(reordered), true);
  assert.equal(gate.publishBrief(brief, { ...evidence, features: { degraded: true } }, { degraded: false }).answers.length, 0);
  assert.match(gate.publishBrief(brief, evidence, { degraded: false }).publicationNote, /Other dashboard sections may contain newer/);
});
