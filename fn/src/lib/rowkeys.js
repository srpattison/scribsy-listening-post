'use strict';

// Row-key and row-kind rules. Kept free of the Azure SDK so they can be unit
// tested and reused by read paths that must not open a storage connection.

// Reddit comment ids and submission ids are separate base-36 spaces, so the
// same string can legitimately appear as both. Comment rows carry a `c_` prefix
// to guarantee no collision. Submission keys are unchanged — the existing
// corpus needs no migration.
const rowKeyFor = (item) => (item && item.kind === 'comment' ? `c_${item.id}` : item.id);

// `kind` is absent on every row written before round 4. A missing kind reads as
// a submission rather than requiring a data migration (§3a.2).
const kindOf = (row) => (row && row.kind === 'comment' ? 'comment' : 'post');

// Recover the source id from a stored row key.
const idFromRowKey = (rowKey) => String(rowKey || '').replace(/^c_/, '');

module.exports = { rowKeyFor, kindOf, idFromRowKey };
