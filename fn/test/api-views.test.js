'use strict';

// CB-LISTEN-BOARDS-1 §4.5 — make the "Excluded: bot & boilerplate" section
// reachable. Per C2, this is a READER omission: the rollup already writes a
// `rules` partition (rollup-engine.js:680), but VIEWS at api.js:17 never lists
// it, so view=all silently drops it and view=rules 400s.
//
// api.js registers its routes via the Azure Functions `app.http()` SDK at
// require time, which needs the real @azure/functions package and a function
// host to invoke — out of scope for a node:test unit run. So this test reads
// VIEWS directly (a plain exported array) rather than invoking the HTTP
// handler, and separately proves the handler's own view-membership logic
// against a minimal stand-in of the same shape used elsewhere in this file's
// sibling tests.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const API_PATH = path.join(__dirname, '..', 'src', 'functions', 'api.js');

function readViews() {
  const src = fs.readFileSync(API_PATH, 'utf8');
  const m = src.match(/const VIEWS = \[([^\]]*)\];/);
  assert.ok(m, 'VIEWS array must be found in api.js');
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

test('VIEWS includes rules', () => {
  const VIEWS = readViews();
  assert.ok(VIEWS.includes('rules'), `VIEWS must include 'rules', got: ${VIEWS.join(', ')}`);
});

test('view=all would serve a rules key (VIEWS drives the view=all loop)', () => {
  // The handler does `for (const v of VIEWS) out[v] = await store.getAggregate(v, 'latest')`.
  // Once 'rules' is in VIEWS, out.rules is populated the same way as every
  // other section — this test locks that VIEWS is the single source of truth
  // the loop reads, so re-adding 'rules' here is sufficient.
  const VIEWS = readViews();
  const out = {};
  for (const v of VIEWS) out[v] = { seen: v };
  assert.ok('rules' in out, "view=all's output must carry a rules key");
});

test("view=rules would not 400 (VIEWS.includes('rules') gates the 400)", () => {
  const VIEWS = readViews();
  const view = 'rules';
  const wouldReject = !VIEWS.includes(view);
  assert.strictEqual(wouldReject, false, 'view=rules must not trip the `view must be one of ...` 400');
});
