'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { frozenPilotRows } = require('../src/lib/frozen-pilot');
const { digest, identity } = require('../src/lib/quality-benchmark');
test('frozen pilot restores manifest order without changing membership and rejects altered rows', () => {
  const rows = Array.from({ length: 1000 }, (_, i) => ({ partitionKey: 'writing', rowKey: String(i) }));
  const ids = rows.map(identity);
  const archive = { pilotRows: [...rows].reverse(), manifest: { pilotIds: ids, pilot: { selectionHash: digest(ids.join('\n')) } } };
  assert.deepEqual(frozenPilotRows(archive), rows);
  archive.pilotRows[0] = rows[0];
  assert.throws(() => frozenPilotRows(archive), /row set mismatch/);
  archive.pilotRows = rows; archive.manifest.pilotIds[0] = 'writing|altered';
  assert.throws(() => frozenPilotRows(archive), /manifest mismatch/);
});
