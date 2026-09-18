'use strict';

// node scripts/quality-benchmark.js <private-output-dir> [settings-json]
// Reads production sources but performs NO storage writes or model calls.
// Private output must be outside the repository; only summary.json is shareable.
const fs = require('node:fs');
const path = require('node:path');
const q = require('../src/lib/quality-benchmark');
const { idFromRowKey, kindOf } = require('../src/lib/rowkeys');

async function main() {
  if (!process.argv[2]) throw new Error('Private output directory required');
  const out = path.resolve(process.argv[2]), repo = path.resolve(__dirname,'../..');
  const relative = path.relative(repo,out);
  if (!relative || (!relative.startsWith('..'+path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw new Error('Output must be outside repository');
  if (fs.existsSync(out)) throw new Error('Use a new output directory to preserve prior benchmark evidence');
  if (process.argv[3]) for (const setting of JSON.parse(fs.readFileSync(process.argv[3],'utf8'))) process.env[setting.name] = setting.value;
  const store = require('../src/lib/store');
  const filter = require('../src/lib/boilerplate-filter');
  fs.mkdirSync(out,{recursive:true,mode:0o700});
  const save = (name,value) => fs.writeFileSync(path.join(out,name),JSON.stringify(value),{mode:0o600});
  const rows = await store.listAnalyzedPosts();
  save('rows.private.json',rows);
  const panel=q.selectSample(rows,120), pilot=q.selectSample(rows,1000), challenges=q.recurrenceChallenges(rows);
  save('manifest.private.json',{panel:panel.manifest,pilot:pilot.manifest,panelIds:panel.selected.map(q.identity),pilotIds:pilot.selected.map(q.identity)});
  const registryCache=new Map(), records=new Map();
  const selected=[...new Map([...panel.selected,...challenges.map(c=>c.row)].map(r=>[q.identity(r),r])).values()];
  for (const row of selected) {
    const id=q.identity(row);
    if (!registryCache.has(row.partitionKey)) {
      try { registryCache.set(row.partitionKey,{registry:(await filter.loadRegistryForSubs(store,[row.partitionKey])).get(row.partitionKey.toLowerCase()),registryAvailable:true}); }
      catch { registryCache.set(row.partitionKey,{registryAvailable:false}); }
    }
    let raw;
    try { raw=await store.getRaw(row.partitionKey,row.createdUtc,idFromRowKey(row.rowKey),kindOf(row)); }
    catch { records.set(id,{id,error:'raw-unavailable'}); continue; }
    try { records.set(id,{id,row,raw,...registryCache.get(row.partitionKey),registry:undefined,checks:q.checkQuotes(row,raw,registryCache.get(row.partitionKey))}); }
    catch { records.set(id,{id,error:'analysis',row,raw}); }
  }
  save('review.private.json',[...records.values()]);
  const summary={version:1,createdAt:new Date().toISOString(),population:rows.length,panelManifest:panel.manifest,pilotManifest:pilot.manifest,
    diagnostic:q.summarize(panel.selected.map(r=>records.get(q.identity(r)))),
    challenge:q.summarize(challenges.map(c=>records.get(q.identity(c.row)))),
    challengeGroups:challenges.length,modelCalls:0,productionWrites:0,
    limitations:['Diagnostic sample is balanced, not a population prevalence estimate.','Challenge set is deliberately enriched for repeated text; repetition is not proof of boilerplate.','Missing, short, multiple-origin, and unmatched quotes require review, not fabricated-quote claims.','Registry checks use current rules, not reconstruction of the original model input.','The 1000-row pilot is selected, not reanalyzed.']};
  save('summary.json',summary);
  console.log(JSON.stringify(summary));
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
