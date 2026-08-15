'use strict';

// Azure Table Storage size guards.
//
// A String property holds at most 64 KiB, and Table Storage counts it as
// UTF-16 — so the real ceiling is 32,768 CHARACTERS, not 64,000. An entity is
// capped at 1 MiB across all of its properties.
//
// Before round 3 the store wrote `JSON.stringify(payload).slice(0, 60_000)`.
// That is over the character ceiling for any large payload: Table Storage
// rejects the whole entity with PropertyValueTooLarge (400) and the caller
// throws. It was also unsafe when it did happen to fit, because a sliced JSON
// string is no longer valid JSON and comes back unparseable.
//
// This module never emits invalid JSON. Large payloads are split across
// numbered chunk properties (json, json1, json2 …) and reassembled on read.
// Only when a payload cannot fit even chunked is it shrunk DELIBERATELY — by
// dropping its largest top-level fields and recording what was dropped, so a
// truncated aggregate says so instead of pretending to be complete.

const MAX_PROP_CHARS = 30000;                        // margin under the 32,768-char cap
const MAX_CHUNKS = 12;                               // ≈720 KB UTF-16, inside the 1 MiB entity cap
const MAX_TOTAL_CHARS = MAX_PROP_CHARS * MAX_CHUNKS;

function chunk(str, size = MAX_PROP_CHARS) {
  const out = [];
  for (let i = 0; i < str.length; i += size) out.push(str.slice(i, i + size));
  return out.length ? out : [''];
}

// Deliberate shrink: drop the largest top-level fields until the payload fits.
// Returns the reduced value plus the names dropped, never invalid JSON.
function shrinkToFit(payload, maxChars = MAX_TOTAL_CHARS) {
  let json = JSON.stringify(payload);
  if (json === undefined) return { value: null, dropped: [], chars: 4 };
  if (json.length <= maxChars) return { value: payload, dropped: [], chars: json.length };

  const dropped = [];
  // Arrays shrink by trimming from the tail; objects by dropping fat fields.
  if (Array.isArray(payload)) {
    const arr = payload.slice();
    while (arr.length > 0 && JSON.stringify(arr).length > maxChars) {
      arr.length = Math.floor(arr.length / 2);
    }
    dropped.push(`${payload.length - arr.length} trailing items`);
    json = JSON.stringify(arr);
    return { value: arr, dropped, chars: json.length };
  }

  if (!payload || typeof payload !== 'object') {
    // A bare oversized scalar (only ever a giant string) — truncate the VALUE,
    // not the encoded JSON, so the result still parses.
    const s = String(payload).slice(0, Math.max(0, maxChars - 64));
    return { value: s, dropped: ['value truncated'], chars: JSON.stringify(s).length };
  }

  const out = { ...payload };
  const sizeOf = (k) => {
    try { return (JSON.stringify(out[k]) || '').length; } catch { return 0; }
  };
  // Reserve room for the _truncated marker we append below.
  const budget = maxChars - 512;
  while (JSON.stringify(out).length > budget) {
    const keys = Object.keys(out).filter((k) => k !== '_truncated');
    if (!keys.length) break;
    const fattest = keys.sort((a, b) => sizeOf(b) - sizeOf(a))[0];
    delete out[fattest];
    dropped.push(fattest);
  }
  if (dropped.length) out._truncated = { droppedFields: dropped, reason: 'exceeded Azure Table entity size cap' };
  return { value: out, dropped, chars: JSON.stringify(out).length };
}

// Encode a payload into Table Storage properties. Always valid JSON on read.
function packJson(payload) {
  const { value, dropped } = shrinkToFit(payload);
  const json = JSON.stringify(value === undefined ? null : value);
  const parts = chunk(json);
  const props = { json: parts[0], jsonChunks: parts.length };
  for (let i = 1; i < parts.length; i++) props['json' + i] = parts[i];
  return { props, chars: json.length, chunks: parts.length, dropped };
}

// Reassemble and parse. Never throws: unparseable rows are reported, not raised,
// so one corrupt row cannot take down a read path.
function unpackJson(entity) {
  if (!entity || entity.json === undefined || entity.json === null) {
    return { ok: false, error: 'no json property on entity' };
  }
  const n = Number(entity.jsonChunks) || 1;
  let s = String(entity.json);
  for (let i = 1; i < n; i++) s += String(entity['json' + i] ?? '');
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch (e) {
    return { ok: false, error: `unparseable stored payload (${e.message})` };
  }
}

// Fit a single string property (used for analysisJson), keeping it valid JSON
// by shrinking the OBJECT rather than slicing the encoded string.
function packProperty(obj, maxChars = MAX_PROP_CHARS) {
  const { value, dropped } = shrinkToFit(obj, maxChars);
  return { json: JSON.stringify(value === undefined ? null : value), dropped };
}

module.exports = {
  MAX_PROP_CHARS,
  MAX_CHUNKS,
  MAX_TOTAL_CHARS,
  chunk,
  shrinkToFit,
  packJson,
  unpackJson,
  packProperty
};
