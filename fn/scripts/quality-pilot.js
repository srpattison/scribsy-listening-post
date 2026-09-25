'use strict';

// Bounded private comparison. Never saves analysis, embeddings or queues.
// Usage: node scripts/quality-pilot.js <archive.json> <settings.json> <new-private-dir>
//          [--ids=<ids.json>] [--max-rows=<n>] [--resume]
// Without --ids the frozen 1,000-row pilot is replayed. With --ids only the
// listed `partitionKey|rowKey` identities are replayed, in list order, from the
// archive's pilotRows (CB-LISTEN-REPLAY-1). The list has a hard ceiling of
// ID_CEILING rows; --max-rows may only lower it.
const fs = require('node:fs');
const path = require('node:path');
const { digest, identity, checkQuotes } = require('../src/lib/quality-benchmark');

const ID_CEILING = 50;
const MAX_WORKERS = 16;
const REPO = path.resolve(__dirname, '../..');

// One replayed row, through the SAME exclusion and grounding steps as the live
// analyze worker (CB-LISTEN-FIX-1b R2): excluded units never reach the model,
// an excluded submission is not analysed (and reserves no cap slot), and the
// stored result carries `grounding` counts. `deps.analyzePost` and
// `deps.reserve` are injected so this is testable without a model or store.
// The pipeline loads config, so it is required here rather than at the top:
// a rejected ID list must fail before any config module loads.
async function replayRow(row, raw, { registry, analyzePost, reserve, checkQuotes }) {
  const { excludeUnits, groundOutput } = require('../src/lib/analysis-pipeline');
  const units = excludeUnits(raw, { registry });
  if (units.postExcluded) return { skipped: `excluded-post:${units.postReason}`, filteredComments: units.auditReasons };
  if (!(await reserve())) return { stopped: 'daily-cap' };
  const modelOutput = await analyzePost(raw.post, units.promptComments);
  delete modelOutput._provenance;
  const analysis = groundOutput(modelOutput, raw.post, units.promptComments);
  const newRow = { ...row, analysisJson: JSON.stringify(analysis) };
  const old = JSON.parse(row.analysisJson);
  return {
    analysis, filteredComments: units.auditReasons,
    oldChecks: checkQuotes(row, raw, { registry }), newChecks: checkQuotes(newRow, raw, { registry }),
    changedFields: Object.keys(analysis).filter(key => JSON.stringify(analysis[key]) !== JSON.stringify(old[key]))
  };
}

function assertOutsideRepo(target, label) {
  const relative = path.relative(REPO, path.resolve(target));
  if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw new Error(`${label} must be outside repository`);
}

// Positional <archive> <settings> <out> come first; flags follow. The bare
// `--resume` fourth argument of the original usage still works.
function parseArgs(argv) {
  const positional = [], flags = { idsPath: null, maxRows: null, resume: false };
  for (const arg of argv) {
    if (arg === '--resume') flags.resume = true;
    else if (arg.startsWith('--ids=')) flags.idsPath = arg.slice('--ids='.length);
    else if (arg.startsWith('--max-rows=')) {
      const text = arg.slice('--max-rows='.length);
      if (!/^\d+$/.test(text)) throw new Error('--max-rows must be a positive integer');
      flags.maxRows = Number(text);
    } else if (arg.startsWith('--')) throw new Error(`Unknown flag ${arg}`);
    else positional.push(arg);
  }
  const [archivePath, settingsPath, outputPath, ...extra] = positional;
  if (!archivePath || !settingsPath || !outputPath) throw new Error('Archive, settings and new private output directory required');
  if (extra.length) throw new Error('Unexpected extra arguments');
  if (flags.maxRows !== null && !flags.idsPath) throw new Error('--max-rows applies only with --ids');
  return { archivePath, settingsPath, outputPath, ...flags };
}

function idCeiling(maxRows) {
  if (maxRows === null || maxRows === undefined) return ID_CEILING;
  if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > ID_CEILING) throw new Error(`--max-rows may only lower the ceiling (1..${ID_CEILING})`);
  return maxRows;
}

function checkIdList(ids, maxRows) {
  if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string' || !id.includes('|'))) throw new Error('ID list must be a non-empty JSON array of partitionKey|rowKey identities');
  const ceiling = idCeiling(maxRows);
  if (ids.length > ceiling) throw new Error(`ID list has ${ids.length} rows; ceiling is ${ceiling}`);
  if (new Set(ids).size !== ids.length) throw new Error('ID list contains duplicates');
  return ids;
}

function readIdList(idsPath, maxRows) {
  assertOutsideRepo(idsPath, 'ID list');
  return checkIdList(JSON.parse(fs.readFileSync(idsPath, 'utf8')), maxRows);
}

// Row selection. ID mode never falls back to the full pilot: an ID that is not
// in archive.pilotRows is an error before any spend.
function selectRows(archive, { ids = null, maxRows = null } = {}) {
  if (!ids) {
    return { mode: 'frozen', rows: require('../src/lib/frozen-pilot').frozenPilotRows(archive), selectionHash: archive.manifest.pilot.selectionHash };
  }
  checkIdList(ids, maxRows);
  const byId = new Map((Array.isArray(archive.pilotRows) ? archive.pilotRows : []).map(row => [identity(row), row]));
  const missing = ids.filter(id => !byId.has(id)).length;
  if (missing) throw new Error(`${missing} listed ID(s) not in archive pilotRows; refusing to replay`);
  return { mode: 'ids', rows: ids.map(id => byId.get(id)), selectionHash: digest(ids.join('\n')), idCount: ids.length };
}

function checkResume(previous, selection) {
  const allowed = new Set(selection.rows.map(identity)), completed = previous.results.map(result => result.id);
  if (previous.selectionHash !== selection.selectionHash || (previous.mode || 'frozen') !== selection.mode ||
      new Set(completed).size !== completed.length || completed.some(id => !allowed.has(id))) throw new Error('Resume checkpoint membership mismatch');
}

// The store, model and cap modules, loaded only after selection has passed.
async function loadRuntime(rows) {
  const store = require('../src/lib/store'), aoai = require('../src/lib/aoai');
  const registry = await require('../src/lib/boilerplate-filter').loadRegistryForSubs(store, rows.map(row => row.partitionKey));
  const { idFromRowKey, kindOf } = require('../src/lib/rowkeys');
  const { reserveDailySlot } = require('../src/lib/daily-cap');
  const config = require('../src/lib/config');
  return {
    analyzePost: aoai.analyzePost,
    getRaw: row => store.getRaw(row.partitionKey, row.createdUtc, idFromRowKey(row.rowKey), kindOf(row)),
    registryFor: row => registry.get(String(row.partitionKey).toLowerCase()) || new Set(),
    reserve: async () => {
      const day = new Date().toISOString().slice(0, 10);
      const { cap, configError } = config.dailyAnalyzeCap();
      if (configError) throw new Error('Invalid daily-cap configuration');
      return (await reserveDailySlot(store.aggregateBackend('analyze-counter', day), cap)).ok;
    },
    saveBlobJson: (name, value) => store.saveBlobJson(name, value),
    meter: usage => {
      const realFetch = globalThis.fetch;
      globalThis.fetch = async (...args) => {
        const response = await realFetch(...args);
        if (String(args[0]).includes('/chat/completions')) {
          usage.requests++;
          try {
            const body = await response.clone().json();
            if (body.usage) {
              usage.responsesWithUsage++;
              usage.promptTokens += body.usage.prompt_tokens || 0;
              usage.completionTokens += body.usage.completion_tokens || 0;
              usage.totalTokens += body.usage.total_tokens || 0;
            }
          } catch { /* metering absence remains visible */ }
        }
        return response;
      };
      return () => { globalThis.fetch = realFetch; };
    }
  };
}

// `deps.loadRuntime(rows)` is injectable so selection and the worker loop are
// testable without a store or model. Everything before it is spend-free.
async function main(argv = process.argv.slice(2), deps = {}) {
  const args = parseArgs(argv);
  const out = path.resolve(args.outputPath);
  assertOutsideRepo(out, 'Output');
  const ids = args.idsPath ? readIdList(args.idsPath, args.maxRows) : null;
  if (fs.existsSync(out) && !args.resume) throw new Error('Output already exists; use explicit --resume to continue preserved evidence');
  const archive = JSON.parse(fs.readFileSync(args.archivePath, 'utf8'));
  const selection = selectRows(archive, { ids, maxRows: args.maxRows });
  const { rows } = selection;
  let previous = null;
  if (args.resume) {
    const file = path.join(out, 'pilot.private.json');
    previous = JSON.parse(fs.readFileSync(file, 'utf8'));
    checkResume(previous, selection);
    fs.copyFileSync(file, path.join(out, `before-resume-${Date.now()}.private.json`), fs.constants.COPYFILE_EXCL);
  }
  for (const setting of JSON.parse(fs.readFileSync(args.settingsPath, 'utf8'))) process.env[setting.name] = setting.value;
  fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  const runtime = await (deps.loadRuntime || loadRuntime)(rows);
  const usage = previous?.usage || { requests: 0, responsesWithUsage: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  const unmeter = runtime.meter ? runtime.meter(usage) : () => {};
  const results = previous?.results || [], startedAt = previous?.startedAt || new Date().toISOString();
  const completedIds = new Set(results.map(result => result.id));
  const pendingRows = rows.filter(row => !completedIds.has(identity(row)));
  let cursor = 0, errors = previous?.errors || 0, consecutiveErrors = 0, stopped = null, checkpoint = Promise.resolve();
  const blobName = `lp-quality/${path.basename(out)}`;
  const snapshot = () => ({ version: 1, mode: selection.mode, ...(selection.mode === 'ids' ? { idCount: selection.idCount } : {}),
    startedAt, updatedAt: new Date().toISOString(), selectionHash: selection.selectionHash,
    selected: rows.length, processed: results.length, errors, stopped, usage: { ...usage }, results: [...results],
    productionAnalysisWrites: 0, note: 'Old/new outputs are comparison evidence, not semantic gold. Daily cap reservations are recorded; no cap increase.' });
  const persist = () => {
    const value = snapshot();
    fs.writeFileSync(path.join(out, 'pilot.private.json'), JSON.stringify(value), { mode: 0o600 });
    checkpoint = checkpoint.then(() => runtime.saveBlobJson(blobName, value));
    return checkpoint;
  };
  try {
    await Promise.all(Array.from({ length: Math.min(MAX_WORKERS, pendingRows.length) }, async () => {
      while (cursor < pendingRows.length && !stopped) {
        const row = pendingRows[cursor++], id = identity(row);
        try {
          const raw = await runtime.getRaw(row);
          const result = await replayRow(row, raw, { registry: runtime.registryFor(row), analyzePost: runtime.analyzePost, reserve: runtime.reserve, checkQuotes });
          if (result.stopped) { stopped = result.stopped; break; }
          consecutiveErrors = 0;
          results.push({ id, row, raw, ...result });
        } catch (error) {
          errors++;
          consecutiveErrors++;
          results.push({ id, error: 'row-comparison-failed', privateDetail: error.message });
          // Sparse refusals remain in the denominator; an outage stops spend.
          if (consecutiveErrors >= 5) stopped = 'five-consecutive-row-errors';
        }
        if (results.length % 10 === 0) {
          await persist();
          console.log(JSON.stringify({ processed: results.length, errors, usage }));
        }
      }
    }));
    await persist();
    const summary = { mode: selection.mode, selected: rows.length, processed: results.length, errors, stopped, usage, archive: blobName };
    console.log(JSON.stringify(summary));
    if (stopped || errors || results.length !== rows.length) process.exitCode = 1;
    return summary;
  } finally { unmeter(); }
}
if (require.main === module) {
  main().catch(() => { console.error('Pilot failed; inspect private evidence. No production analysis was replaced.'); process.exitCode = 1; });
}

module.exports = { replayRow, main, parseArgs, selectRows, checkResume, readIdList, ID_CEILING };
