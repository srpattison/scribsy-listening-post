'use strict';
const { digest, identity } = require('./quality-benchmark');
function frozenPilotRows(archive) {
  const rows = archive.pilotRows, ids = archive.manifest?.pilotIds;
  if (!Array.isArray(rows) || rows.length !== 1000 || !Array.isArray(ids) || ids.length !== 1000 ||
      digest(ids.join('\n')) !== archive.manifest?.pilot?.selectionHash) throw new Error('Frozen pilot manifest mismatch');
  const byId = new Map(rows.map(row => [identity(row), row]));
  if (byId.size !== 1000 || new Set(ids).size !== 1000 || ids.some(id => !byId.has(id))) throw new Error('Frozen pilot row set mismatch');
  // Archives may serialize records in table order. The manifest is the
  // authoritative selection order; reordering never changes membership.
  return ids.map(id => byId.get(id));
}
module.exports = { frozenPilotRows };
