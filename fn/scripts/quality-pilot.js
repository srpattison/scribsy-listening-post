'use strict';

// Bounded private comparison. Never saves analysis, embeddings or queues.
// Usage: node scripts/quality-pilot.js <archive.json> <settings.json> <new-private-dir>
const fs = require('node:fs');
const path = require('node:path');

async function main() {
  const [archivePath, settingsPath, outputPath] = process.argv.slice(2);
  if (!archivePath || !settingsPath || !outputPath) throw new Error('Archive, settings and new private output directory required');
  const out = path.resolve(outputPath), repo = path.resolve(__dirname, '../..');
  const relative = path.relative(repo, out);
  if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw new Error('Output must be outside repository');
  const resume = process.argv[5] === '--resume';
  if (fs.existsSync(out) && !resume) throw new Error('Output already exists; use explicit --resume to continue preserved evidence');
  const archive = JSON.parse(fs.readFileSync(archivePath, 'utf8'));
  const rows = require('../src/lib/frozen-pilot').frozenPilotRows(archive);
  const q = require('../src/lib/quality-benchmark');
  let previous = null;
  if (resume) {
    const file = path.join(out, 'pilot.private.json');
    previous = JSON.parse(fs.readFileSync(file, 'utf8'));
    const allowed = new Set(rows.map(q.identity)), completed = previous.results.map(result => result.id);
    if (previous.selectionHash !== archive.manifest.pilot.selectionHash ||
        new Set(completed).size !== completed.length || completed.some(id => !allowed.has(id))) throw new Error('Resume checkpoint membership mismatch');
    fs.copyFileSync(file, path.join(out, `before-resume-${Date.now()}.private.json`), fs.constants.COPYFILE_EXCL);
  }
  for (const setting of JSON.parse(fs.readFileSync(settingsPath, 'utf8'))) process.env[setting.name] = setting.value;
  fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  const store = require('../src/lib/store'), aoai = require('../src/lib/aoai');
  const registry = await require('../src/lib/boilerplate-filter').loadRegistryForSubs(store, rows.map(row => row.partitionKey));
  const { filterComments } = require('../src/lib/comment-filter');
  const { idFromRowKey, kindOf } = require('../src/lib/rowkeys');
  const { reserveDailySlot } = require('../src/lib/daily-cap');
  const config = require('../src/lib/config');
  const usage = previous?.usage || { requests: 0, responsesWithUsage: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
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
  const results = previous?.results || [], startedAt = previous?.startedAt || new Date().toISOString();
  const completedIds = new Set(results.map(result => result.id));
  const pendingRows = rows.filter(row => !completedIds.has(q.identity(row)));
  let cursor = 0, errors = previous?.errors || 0, consecutiveErrors = 0, stopped = null, checkpoint = Promise.resolve();
  const blobName = `lp-quality/${path.basename(out)}`;
  const snapshot = () => ({ version: 1, startedAt, updatedAt: new Date().toISOString(), selectionHash: archive.manifest.pilot.selectionHash,
    selected: rows.length, processed: results.length, errors, stopped, usage: { ...usage }, results: [...results],
    productionAnalysisWrites: 0, note: 'Old/new outputs are comparison evidence, not semantic gold. Daily cap reservations are recorded; no cap increase.' });
  const persist = () => {
    const value = snapshot();
    fs.writeFileSync(path.join(out, 'pilot.private.json'), JSON.stringify(value), { mode: 0o600 });
    checkpoint = checkpoint.then(() => store.saveBlobJson(blobName, value));
    return checkpoint;
  };
  try {
    await Promise.all(Array.from({ length: 16 }, async () => {
      while (cursor < pendingRows.length && !stopped) {
        const row = pendingRows[cursor++], id = q.identity(row);
        try {
          const raw = await store.getRaw(row.partitionKey, row.createdUtc, idFromRowKey(row.rowKey), kindOf(row));
          const hashes = registry.get(String(row.partitionKey).toLowerCase());
          const { kept, reasons } = filterComments(raw.comments || [], { registry: hashes, minChars: config.boilerplateMinCharsBody() });
          const day = new Date().toISOString().slice(0, 10);
          const { cap, configError } = config.dailyAnalyzeCap();
          if (configError) throw new Error('Invalid daily-cap configuration');
          const reservation = await reserveDailySlot(store.aggregateBackend('analyze-counter', day), cap);
          if (!reservation.ok) { stopped = 'daily-cap'; break; }
          const analysis = await aoai.analyzePost(raw.post, kept);
          consecutiveErrors = 0;
          const newRow = { ...row, analysisJson: JSON.stringify(analysis) };
          results.push({ id, row, raw, analysis, filteredComments: reasons,
            oldChecks: q.checkQuotes(row, raw, { registry: hashes }), newChecks: q.checkQuotes(newRow, raw, { registry: hashes }),
            changedFields: Object.keys(analysis).filter(key => key !== '_provenance' && JSON.stringify(analysis[key]) !== JSON.stringify(JSON.parse(row.analysisJson)[key])) });
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
    console.log(JSON.stringify({ selected: rows.length, processed: results.length, errors, stopped, usage, archive: blobName }));
    if (stopped || errors || results.length !== rows.length) process.exitCode = 1;
  } finally { globalThis.fetch = realFetch; }
}
main().catch(() => { console.error('Pilot failed; inspect private evidence. No production analysis was replaced.'); process.exitCode = 1; });
