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
  return { run: (names = ['outline']) => sandbox.module.exports.normalizeFeatures(names), calls };
}

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
