'use strict';

// CB-LISTEN-REPLAY-1: build the private ID list for a bounded replay.
// Zero model calls, zero network, zero repo writes.
//
// Usage: LP_PRIVATE_DIR=/path/outside/repo node scripts/replay-ids.js
//
// Reads ONLY from $LP_PRIVATE_DIR (same refuse-inside-repo rule as
// private-fixture-check). Writes $LP_PRIVATE_DIR/out/replay-ids.json: the
// starter cases first, then the judged records in report order, deduplicated,
// as `partitionKey|rowKey` identities from the pilot archive. Prints COUNTS
// ONLY: no record text, no record ids, no usernames.
//
// Starter cases carry only a masked caseKey and their source. The blind packet
// is shuffled relative to the report queue, so a caseKey is NOT a queue
// position; each starter case is resolved by its post title, which must match
// exactly one pilot row.

const fs = require('node:fs');
const path = require('node:path');
const { identity } = require('../src/lib/quality-benchmark');
const { resolvePrivateDir } = require('./private-fixture-check');
const { ID_CEILING } = require('./quality-pilot');

const FILES = {
  starter: 'semantic-review-20260919-v2-starter.json',
  report: 'semantic-review-20260919-v2-report.json',
  pilot: '2026-09-18-e372b521b6ecaaee.json'
};

const titleKey = (title) => String(title || '').trim().toLowerCase();

function buildIdList({ starter, report, archive }) {
  const rows = Array.isArray(archive.pilotRows) ? archive.pilotRows : [];
  const pilotIds = new Set(rows.map(identity));
  const byTitle = new Map();
  for (const row of rows) {
    const key = titleKey(row.title);
    byTitle.set(key, (byTitle.get(key) || []).concat(identity(row)));
  }
  const starterIds = [];
  let starterAmbiguous = 0, starterUnmatched = 0;
  for (const c of starter.cases || []) {
    const hits = byTitle.get(titleKey(c && c.source && c.source.post && c.source.post.title)) || [];
    if (hits.length === 1) starterIds.push(hits[0]);
    else if (hits.length > 1) starterAmbiguous++;
    else starterUnmatched++;
  }
  const judgedIds = [...new Set((report.reviews || []).map((r) => r.id))];
  const ids = [...new Set([...starterIds, ...judgedIds])];
  const counts = {
    starterCases: (starter.cases || []).length,
    starterResolved: starterIds.length,
    starterAmbiguous,
    starterUnmatched,
    judgedDistinct: judgedIds.length,
    starterAlsoJudged: starterIds.filter((id) => judgedIds.includes(id)).length,
    derivedIds: ids.length,
    resolvedInPilotRows: ids.filter((id) => pilotIds.has(id)).length,
    unresolved: ids.filter((id) => !pilotIds.has(id)).length + starterAmbiguous + starterUnmatched
  };
  return { ids, counts };
}

function run() {
  let dir;
  try { dir = resolvePrivateDir(); } catch (e) { console.error(e.message); process.exitCode = 2; return; }
  if (!dir) { console.log('skipped: LP_PRIVATE_DIR not set'); return; }
  const read = (key) => JSON.parse(fs.readFileSync(path.join(dir, FILES[key]), 'utf8'));
  const { ids, counts } = buildIdList({ starter: read('starter'), report: read('report'), archive: read('pilot') });
  const ok = counts.unresolved === 0 && ids.length <= ID_CEILING;
  console.log(JSON.stringify({ modelCalls: 0, ceiling: ID_CEILING, ...counts, written: ok ? 1 : 0 }, null, 2));
  if (!ok) { process.exitCode = 1; return; }
  const outDir = path.join(dir, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'replay-ids.json'), JSON.stringify(ids, null, 2), { mode: 0o600 });
}

if (require.main === module) run();

module.exports = { buildIdList };
