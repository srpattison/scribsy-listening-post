'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const q=require('../src/lib/quality-benchmark');
const row=(id,sub='writing')=>({rowKey:id,partitionKey:sub,createdUtc:1700000000,analysisJson:'{}'});
test('sample is reproducible across reversed storage order and records uncovered strata',()=>{
  const rows=Array.from({length:30},(_,i)=>row(String(i),'sub'+i%6));
  const a=q.selectSample(rows,12),b=q.selectSample([...rows].reverse(),12);
  assert.equal(a.manifest.selectionHash,b.manifest.selectionHash);
  assert.equal(new Set(a.selected.map(q.identity)).size,12);
  assert.ok(a.manifest.strata.every(s=>s.selected===2));
  assert.equal(q.selectSample(rows,3).manifest.strata.filter(s=>s.selected===0).length,3);
  assert.notEqual(a.manifest.selectionHash,q.selectSample(rows,12,'different').manifest.selectionHash);
});
test('invalid limits and duplicate identities fail instead of fabricating coverage',()=>{
  assert.throws(()=>q.selectSample([row('x'),row('x')]),/Duplicate/);
  assert.throws(()=>q.selectSample([],0),/Positive/);
  assert.equal(q.selectSample([],120).selected.length,0);
});
test('quote provenance separates own text, filtered sources, ambiguity and unmatched text',()=>{
  const own='I want to preserve my individual voice while revising.';
  const rule='Automated feedback is prohibited in this community.';
  const r={...row('a'),analysisJson:JSON.stringify({notable_quote:own,feature_requests:[{quote:rule},{quote:'This sentence does not exist in any source.'},{quote:'not AI'}]})};
  const raw={post:{selftext:own},comments:[{author:'AutoModerator',body:rule}]};
  const checks=q.checkQuotes(r,raw);
  assert.deepEqual(checks.map(c=>c.status),['single-origin','filtered-source-only','not-verified','short-ambiguous']);
  assert.equal(checks[1].matches[0].reason,'automod-author');
  raw.comments.push({author:'human',body:own});
  assert.equal(q.checkQuotes(r,raw)[0].status,'multiple-origins');
  assert.ok(checks.every(c=>c.semanticVerdict==='unreviewed'));
});
test('separate comment rows use own-comment and do not match across source boundaries',()=>{
  const r={...row('c_a'),kind:'comment',analysisJson:JSON.stringify({notable_quote:'The title finishes where the body starts.'})};
  assert.equal(q.checkQuotes(r,{post:{title:'The title finishes',selftext:'where the body starts.'}})[0].status,'not-verified');
  assert.equal(q.checkQuotes(r,{post:{selftext:'The title finishes where the body starts.'}})[0].matches[0].origin,'own-comment');
});
test('recurrence challenges count distinct rows and remain separate from semantic verdicts',()=>{
  const rows=Array.from({length:7},(_,i)=>({...row(String(i)),analysisJson:JSON.stringify({feature_requests:[{quote:'I want a tool that preserves my individual voice.'},{quote:'I want a tool that preserves my individual voice.'}]})}));
  const c=q.recurrenceChallenges(rows);
  assert.equal(c.length,1);assert.equal(c[0].occurrences,7);
  assert.equal(q.recurrenceChallenges(rows.slice(0,5)).length,0);
});
test('missing sources and analysis errors stay in summary denominators',()=>{
  const s=q.summarize([{error:'raw-unavailable'},{error:'analysis'},{registryAvailable:false,checks:[{field:'notable_quote',status:'not-verified'}]}]);
  assert.equal(s.rows,3);assert.equal(s.rawAvailable,1);assert.equal(s.rawUnavailable,1);assert.equal(s.analysisErrors,1);assert.equal(s.quotes,1);
});
