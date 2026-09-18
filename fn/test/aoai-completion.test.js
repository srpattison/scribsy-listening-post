'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const file = require.resolve('../src/lib/aoai');

function client(choice, usage = {}) {
  const calls = [];
  const sandbox = {
    require: createRequire(file), module: { exports: {} },
    process: { env: { AOAI_ENDPOINT: 'https://example.invalid', AOAI_KEY: 'secret-fixture' } },
    fetch: async (_url, options) => {
      calls.push(JSON.parse(options.body));
      return { ok: true, status: 200, json: async () => ({ choices: [choice], usage }) };
    }
  };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  return { run: (names = ['outline']) => sandbox.module.exports.normalizeFeatures(names), brief: pack => sandbox.module.exports.strategyBrief(pack), calls };
}

test('strategy transport preserves late aggregates and scope in valid bounded JSON', async () => {
  const c = client({finish_reason:'stop',message:{content:'{"answers":[{"caveats":"Existing caveat."}]}'}});
  const input = { trustBoard: { builds: [{count:7,examples:[{quote:'x'.repeat(70000)}]}] }, featureScope:{clusteredNames:400,totalNames:48836}, distributions:{stances:{hostile:11}}, sampleQuotes:[{quote:'z'.repeat(61000)},{quote:'complete short quote'}] };
  const result = await c.brief(input);
  const sent = JSON.parse(c.calls[0].messages[1].content.split('EVIDENCE PACK (aggregates + samples):\n')[1]);
  assert.equal(sent.trustBoard.builds[0].count,7);
  assert.equal(sent.distributions.stances.hostile,11);
  assert.equal(sent.featureScope.totalNames,48836);
  assert.equal(sent.sampleQuotes[0].quote,'complete short quote');
  assert.ok(JSON.stringify(sent).length <= 60000);
  assert.match(result.answers[0].caveats,/400 selected entries out of 48836/);
  assert.equal(input.sampleQuotes.length,2);
});

test('oversized strategy aggregates fail before spending rather than being cut off', async () => {
  const c = client({finish_reason:'stop',message:{content:'{"answers":[]}'}});
  await assert.rejects(c.brief({baselineTop:[['x'.repeat(60001),1]]}),/aggregate evidence exceeds/);
  assert.equal(c.calls.length,0);
});

test('unreviewed evidence enforces low confidence even when the model returns high', async () => {
  const c = client({ finish_reason: 'stop', message: { content: '{"answers":[{"answer":"Observed only in the sampled frame.","confidence":"high"}]}' } });
  const result = await c.brief({ evidenceQuality: { semanticReview: 'unreviewed', confidenceCeiling: 'low' } });
  assert.equal(result.answers[0].confidence, 'low');
  assert.match(c.calls[0].messages[0].content, /NOT a count of people who totally reject all AI/);
  assert.match(c.calls[0].messages[0].content, /Never call any frame population-representative/);
  const control = client({ finish_reason: 'stop', message: { content: '{"answers":[{"confidence":"high"}]}' } });
  assert.equal((await control.brief({})).answers[0].confidence, 'high');
});

test('oversized feature input is rejected before a model call rather than silently clipped', async () => {
  const c = client({finish_reason:'stop',message:{content:'{"groups":[]}'}});
  await assert.rejects(c.run(['x'.repeat(20001)]), /input exceeds/);
  assert.equal(c.calls.length, 0);
});

test('empty completion retains safe finish and token diagnostics without payloads', async () => {
  const c = client({ finish_reason: 'length', message: { content: '' } },
    { completion_tokens: 6000, completion_tokens_details: { reasoning_tokens: 6000 } });
  await assert.rejects(c.run(), e => {
    assert.match(e.message, /finish_reason=length/);
    assert.match(e.message, /completion_tokens=6000/);
    assert.match(e.message, /reasoning_tokens=6000/);
    assert.doesNotMatch(e.message, /secret-fixture|outline/);
    return true;
  });
  assert.equal(c.calls.length, 1, 'do not automatically spend on an empty-result retry');
});

test('length-limited parseable JSON is rejected as incomplete', async () => {
  const c = client({ finish_reason: 'length', message: { content: '{"groups":[]}' } });
  await assert.rejects(c.run(), /incomplete.*finish_reason=length/);
});

test('refusal is distinct and does not expose refusal text', async () => {
  const c = client({ finish_reason: 'stop', message: { content: null, refusal: 'private refusal text' } });
  await assert.rejects(c.run(), e => {
    assert.match(e.message, /refused/);
    assert.doesNotMatch(e.message, /private refusal text/);
    return true;
  });
});

test('complete structured output passes with bounded feature-only budget', async () => {
  const c = client({ finish_reason: 'stop', message: { content: '{"groups":[]}' } });
  assert.equal(JSON.stringify(await c.run()), '{"groups":[{"canonical":"outline","members":[0]}]}');
  assert.equal(c.calls[0].max_completion_tokens, 16000);
  assert.equal(c.calls[0].reasoning_effort, undefined);
});

for (const [label, groups] of [
  ['duplicate', [{canonical:'Outline',members:[0,0]}]],
  ['out of range', [{canonical:'Outline',members:[1]}]],
  ['empty group', [{canonical:'Outline',members:[]}]]
]) {
  test(`feature normalization rejects ${label} membership`, async () => {
    const c = client({finish_reason:'stop',message:{content:JSON.stringify({groups})}});
    await assert.rejects(c.run(), /Feature normalization/);
  });
}

test('sparse synonym merges preserve exact duplicates and untouched input indexes exactly once', async () => {
  const c = client({finish_reason:'stop',message:{content:JSON.stringify({groups:[{canonical:'Outline',members:[0,1]}]})}});
  const result = await c.run(['Outline','outline','Outlining tool','Export PDF']);
  assert.equal(JSON.stringify(result), '{"groups":[{"canonical":"Outline","members":[0,1,2]},{"canonical":"Export PDF","members":[3]}]}');
  assert.equal(c.calls[0].messages[1].content.split('\n').length, 3);
});
