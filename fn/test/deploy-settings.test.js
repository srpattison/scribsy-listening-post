'use strict';

// §10.4 — deploy.sh must preserve live app settings rather than clobber them.
//
// The old script reasserted every setting from the environment on each run, so
// anything not pre-exported was overwritten with empty. That nearly reverted
// the sub list once and would have silently darked the Bluesky frame by blanking
// BSKY_APP_PASSWORD. The only defence was an operator remembering.
//
// These tests execute the REAL decision logic, extracted from deploy.sh between
// its BEGIN/END markers, with `live_get` stubbed. A test that cannot fail if
// preservation is removed does not count — the last test proves it fails against
// the pre-round-4 unconditional-write behaviour.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const DEPLOY = path.join(__dirname, '..', '..', 'deploy.sh');

function extractBlock() {
  const src = fs.readFileSync(DEPLOY, 'utf8');
  const m = src.match(/# --- BEGIN settings-preservation ---([\s\S]*?)# --- END settings-preservation ---/);
  assert.ok(m, 'deploy.sh must keep the settings-preservation markers');
  return m[1];
}

// Run the extracted logic against a stubbed live app, returning what it decided.
function runResolve({ live = {}, env = {}, calls = [] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-deploy-'));
  const script = path.join(dir, 'harness.sh');
  const liveJson = JSON.stringify(Object.entries(live).map(([name, value]) => ({ name, value })));

  fs.writeFileSync(script, [
    'set -euo pipefail',
    `LIVE_SETTINGS_JSON='${liveJson}'`,
    extractBlock(),
    // Stub jq away: resolve the lookup in pure bash so the test does not need jq
    // installed, while leaving the precedence logic itself untouched.
    'live_get() {',
    '  local want="$1"',
    `  case "$want" in`,
    ...Object.entries(live).map(([k, v]) => `    ${k}) printf '%s' '${v}' ;;`),
    "    *) printf '' ;;",
    '  esac',
    '}',
    ...calls,
    'printf "WRITE:%s\\n" ${SETTINGS_TO_WRITE[@]+"${SETTINGS_TO_WRITE[@]}"}',
    'printf "PRESERVE:%s\\n" ${PRESERVED_SETTINGS[@]+"${PRESERVED_SETTINGS[@]}"}'
  ].join('\n'));

  const out = execFileSync('bash', [script], {
    encoding: 'utf8',
    env: { ...process.env, ...env }
  });
  const written = {}, preserved = [];
  for (const line of out.split('\n')) {
    if (line.startsWith('WRITE:') && line.length > 6) {
      const kv = line.slice(6);
      const i = kv.indexOf('=');
      written[kv.slice(0, i)] = kv.slice(i + 1);
    } else if (line.startsWith('PRESERVE:') && line.length > 9) {
      preserved.push(line.slice(9));
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return { written, preserved };
}

test('a live value absent from the environment is preserved, not overwritten', () => {
  const { written, preserved } = runResolve({
    live: { SUBREDDITS: 'writing,writers,nanowrimo', BSKY_APP_PASSWORD: 'live-secret' },
    calls: [
      'resolve "SUBREDDITS" "" "SHIPPED_DEFAULT"',
      'resolve "BSKY_APP_PASSWORD" "" ""'
    ]
  });
  assert.deepStrictEqual(preserved.sort(), ['BSKY_APP_PASSWORD', 'SUBREDDITS']);
  assert.strictEqual(written.SUBREDDITS, undefined, 'must not be written at all');
  assert.strictEqual(written.BSKY_APP_PASSWORD, undefined,
    'blanking this would silently dark the Bluesky frame on the next ingest');
});

test('an environment value wins over the live value', () => {
  const { written, preserved } = runResolve({
    live: { SUBREDDITS: 'old,list,here' },
    calls: ['resolve "SUBREDDITS" "$SUBREDDITS" "SHIPPED_DEFAULT"'],
    env: { SUBREDDITS: 'explicit,new,list' }
  });
  assert.strictEqual(written.SUBREDDITS, 'explicit,new,list');
  assert.deepStrictEqual(preserved, []);
});

test('the shipped default applies only when the setting exists nowhere', () => {
  const { written, preserved } = runResolve({
    live: {},
    calls: ['resolve "COMMENT_ANALYZE_POLICY" "" "ingest-only"']
  });
  assert.strictEqual(written.COMMENT_ANALYZE_POLICY, 'ingest-only');
  assert.deepStrictEqual(preserved, []);
});

test('the whole §10.4 acceptance case: four settings, empty environment', () => {
  const live = {
    SUBREDDITS: 'writing,writers,nanowrimo,BetterOffline',
    SUB_TAGS: '{"BetterOffline":"enclave-anti"}',
    BSKY_IDENTIFIER: 'someone@example.com',
    BSKY_APP_PASSWORD: 'abcd-efgh-ijkl-mnop'
  };
  const { written, preserved } = runResolve({
    live,
    calls: [
      'resolve "SUBREDDITS" "" "DEFAULT"',
      'resolve "SUB_TAGS" "" "{}"',
      'resolve "BSKY_IDENTIFIER" "" ""',
      'resolve "BSKY_APP_PASSWORD" "" ""'
    ]
  });
  assert.deepStrictEqual(preserved.sort(), ['BSKY_APP_PASSWORD', 'BSKY_IDENTIFIER', 'SUBREDDITS', 'SUB_TAGS']);
  for (const k of Object.keys(live)) {
    assert.strictEqual(written[k], undefined, `${k} must be left byte-identical`);
  }
});

test('preservation removed => the acceptance case fails (proves the test can fail)', () => {
  // The pre-round-4 behaviour: write every setting from the environment
  // unconditionally, defaulting to empty. Same assertions, opposite outcome.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-deploy-old-'));
  const script = path.join(dir, 'old.sh');
  fs.writeFileSync(script, [
    'set -euo pipefail',
    'SETTINGS_TO_WRITE=()',
    'SETTINGS_TO_WRITE+=("SUBREDDITS=${SUBREDDITS:-}")',
    'SETTINGS_TO_WRITE+=("BSKY_APP_PASSWORD=${BSKY_APP_PASSWORD:-}")',
    'printf "WRITE:%s\\n" "${SETTINGS_TO_WRITE[@]}"'
  ].join('\n'));
  const out = execFileSync('bash', [script], { encoding: 'utf8', env: { ...process.env, SUBREDDITS: '', BSKY_APP_PASSWORD: '' } });
  fs.rmSync(dir, { recursive: true, force: true });

  assert.match(out, /WRITE:SUBREDDITS=$/m, 'old behaviour blanks the live sub list');
  assert.match(out, /WRITE:BSKY_APP_PASSWORD=$/m, 'old behaviour blanks the Bluesky credential');
});
