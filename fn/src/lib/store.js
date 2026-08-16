'use strict';

// Storage helpers: Tables (posts, aggregates), Blob (raw archive), Queue (analysis jobs).
// Everything runs off the function app's own storage connection (AzureWebJobsStorage).

const { TableClient } = require('@azure/data-tables');
const { BlobServiceClient, BlobSASPermissions } = require('@azure/storage-blob');
const { QueueClient } = require('@azure/storage-queue');
const tablesafe = require('./tablesafe');
const { rowKeyFor, kindOf } = require('./rowkeys');

const CONN = () => process.env.AzureWebJobsStorage;

const POSTS_TABLE = 'posts';
const AGG_TABLE = 'aggregates';
const RAW_CONTAINER = 'raw';
const ANALYZE_QUEUE = 'analyze-jobs';
const BACKFILL_QUEUE = 'backfill-jobs';

function postsTable() {
  return TableClient.fromConnectionString(CONN(), POSTS_TABLE);
}
function aggTable() {
  return TableClient.fromConnectionString(CONN(), AGG_TABLE);
}
function analyzeQueue() {
  return new QueueClient(CONN(), ANALYZE_QUEUE);
}
function backfillQueue() {
  return new QueueClient(CONN(), BACKFILL_QUEUE);
}

async function ensureInfra() {
  await postsTable().createTable().catch(swallowExists);
  await aggTable().createTable().catch(swallowExists);
  const blobSvc = BlobServiceClient.fromConnectionString(CONN());
  await blobSvc.getContainerClient(RAW_CONTAINER).createIfNotExists();
  await analyzeQueue().createIfNotExists();
  await backfillQueue().createIfNotExists();
}

function swallowExists(e) {
  if (e.statusCode !== 409) throw e;
}

// Upsert a corpus item (submission or comment). Returns true if NEW.
//
// `score` / `numComments` are still stored, but they are a CAPTURE-TIME
// snapshot from Arctic Shift with variable per-row lag — read paths surface
// them as scoreAtCapture / numCommentsAtCapture and nothing ranks on them.
async function upsertPost(post) {
  const table = postsTable();
  const key = { partitionKey: post.subreddit.toLowerCase(), rowKey: rowKeyFor(post) };
  let isNew = false;
  try {
    await table.getEntity(key.partitionKey, key.rowKey);
  } catch (e) {
    if (e.statusCode === 404) isNew = true;
    else throw e;
  }
  await table.upsertEntity(
    {
      ...key,
      source: post.source || 'reddit',
      kind: post.kind || 'post',
      title: String(post.title || '').slice(0, 500),
      author: post.author,
      score: post.score,
      numComments: post.num_comments,
      createdUtc: post.created_utc,
      permalink: post.permalink,
      flair: post.flair || '',
      // Bot/boilerplate signals, captured at ingest so detection needs no
      // re-fetch. Absent on pre-round-5 rows; the read path tolerates that.
      distinguished: post.distinguished || '',
      stickied: post.stickied === true,
      // Thread reconstruction for comments (§3a.3).
      linkId: post.linkId || undefined,
      parentId: post.parentId || undefined,
      // Cheap triage columns so the comment-analysis policy can be evaluated as
      // a dry run over the table, with zero blob reads and zero model calls.
      bodyChars: post.kind === 'comment' ? String(post.selftext || '').length : undefined,
      aiPrefilterHit: post.kind === 'comment' ? !!post.aiPrefilterHit : undefined,
      // Discovery input is extracted at INGEST for comments, because comment
      // analysis is gated and may never run (§3a.7).
      subMentionsCsv: post.kind === 'comment' ? String(post.subMentionsCsv || '') : undefined,
      analyzed: isNew ? false : undefined
    },
    'Merge'
  );
  return isNew;
}

async function saveRaw(post, comments) {
  const blobSvc = BlobServiceClient.fromConnectionString(CONN());
  const container = blobSvc.getContainerClient(RAW_CONTAINER);
  const day = new Date(post.created_utc * 1000).toISOString().slice(0, 10);
  // Comments archive under the same prefixed key as their table row, so the
  // full text is re-analyzable later under a changed policy (§3a.5).
  const name = `${post.subreddit.toLowerCase()}/${day}/${rowKeyFor(post)}.json`;
  const body = JSON.stringify({ post, comments }, null, 0);
  await container.getBlockBlobClient(name).upload(body, Buffer.byteLength(body), {
    blobHTTPHeaders: { blobContentType: 'application/json' }
  });
  return name;
}

async function enqueueAnalysis(job, delaySeconds = 0) {
  const q = analyzeQueue();
  // Queue trigger for Node expects base64-encoded messages by default.
  await q.sendMessage(Buffer.from(JSON.stringify(job)).toString('base64'), {
    visibilityTimeout: delaySeconds || undefined
  });
}

async function enqueueBackfill(job, delaySeconds = 0) {
  const q = backfillQueue();
  await q.sendMessage(Buffer.from(JSON.stringify(job)).toString('base64'), {
    visibilityTimeout: delaySeconds || undefined
  });
}

// One corpus row by id (submissions only — used to resolve a comment's parent).
async function getPostRow(subreddit, postId) {
  try {
    return await postsTable().getEntity(subreddit.toLowerCase(), postId);
  } catch (e) {
    if (e.statusCode === 404) return null;
    throw e;
  }
}

async function saveAnalysis(subreddit, postId, analysis, {
  embB64 = '', schemaVersion = 0, subMentionsCsv = '', kind = 'post',
  botCommentsFiltered = 0, botCommentsFilterReasons = null
} = {}) {
  // analysisJson gets its own property budget and is shrunk by dropping whole
  // fields, never by slicing the encoded string — a sliced JSON string parses
  // as garbage and silently drops the row from every aggregate downstream.
  // The embedding lives in its own property (`emb`) so it can never crowd
  // analysisJson out of the property cap.
  const packed = tablesafe.packProperty(analysis);
  const emb = embB64 && embB64.length <= tablesafe.MAX_PROP_CHARS ? embB64 : '';
  await postsTable().upsertEntity(
    {
      partitionKey: subreddit.toLowerCase(),
      rowKey: rowKeyFor({ id: postId, kind }),
      kind,
      analyzed: true,
      schemaVersion,
      emb,
      subMentionsCsv: String(subMentionsCsv).slice(0, 2000),
      analysisTruncated: packed.dropped.length ? packed.dropped.join(',') : '',
      analysisJson: packed.json,
      // What the prompt-side filter withheld from this row (§3c).
      botCommentsFiltered,
      botCommentsFilterReasons: botCommentsFilterReasons && Object.keys(botCommentsFilterReasons).length
        ? JSON.stringify(botCommentsFilterReasons).slice(0, 500)
        : '',
      aiRelated: !!analysis.ai_related,
      stance: analysis.stance_on_ai || 'na',
      experience: (analysis.persona && analysis.persona.experience) || 'unknown',
      topicsCsv: (analysis.topics || []).join(','),
      stanceBasisCsv: (analysis.stance_basis || []).join(','),
      intensity: analysis.stance_intensity || 0,
      week: analysis.week || ''
    },
    'Merge'
  );
}

async function listAnalyzedPosts() {
  const rows = [];
  const iter = postsTable().listEntities({ queryOptions: { filter: 'analyzed eq true' } });
  for await (const e of iter) rows.push(e);
  return rows;
}

// Drain-rate observability. `az storage queue metadata show` returns nothing on
// this account, so the analysis backlog was unobservable from the CLI — the app
// has to report its own counts.
async function countPosts() {
  let total = 0, analyzed = 0, posts = 0, comments = 0;
  const iter = postsTable().listEntities({ queryOptions: { select: ['RowKey', 'analyzed', 'kind'] } });
  for await (const e of iter) {
    total++;
    if (e.analyzed === true) analyzed++;
    if (kindOf(e) === 'comment') comments++; else posts++;
  }
  return { total, analyzed, unanalyzed: total - analyzed, posts, comments };
}

// Every row, with only the columns the bot/boilerplate detectors need. Used by
// POST /api/retag, which must clean the corpus WITHOUT any model call (§3d).
async function listRowsForRetag() {
  const rows = [];
  const iter = postsTable().listEntities({
    queryOptions: {
      select: ['PartitionKey', 'RowKey', 'kind', 'author', 'title', 'createdUtc',
        'distinguished', 'stickied', 'contentClass', 'contentClassReason']
    }
  });
  for await (const e of iter) rows.push(e);
  return rows;
}

// Write only the classification columns. Merge, so nothing else on the row —
// including analysisJson — is touched. Tagging never rewrites analysis.
async function setContentClass(partitionKey, rowKey, contentClass, contentClassReason) {
  await postsTable().upsertEntity(
    { partitionKey, rowKey, contentClass, contentClassReason: contentClassReason || '' },
    'Merge'
  );
}

// Comment rows with only the triage columns needed to evaluate the analysis
// policy as a DRY RUN — no bodies, no blobs, no model calls (§3b).
async function listCommentTriage() {
  const rows = [];
  const iter = postsTable().listEntities({
    queryOptions: {
      filter: "kind eq 'comment'",
      select: ['PartitionKey', 'RowKey', 'linkId', 'bodyChars', 'aiPrefilterHit', 'analyzed', 'subMentionsCsv', 'createdUtc']
    }
  });
  for await (const e of iter) rows.push(e);
  return rows;
}

// aiRelated by submission id, for the "parent is AI-related" half of the policy
// predicate and for nothing else.
async function analyzedPostAiFlags() {
  const map = new Map();
  const iter = postsTable().listEntities({
    queryOptions: { filter: 'analyzed eq true', select: ['RowKey', 'aiRelated', 'kind'] }
  });
  for await (const e of iter) {
    if (kindOf(e) === 'post') map.set(e.rowKey, !!e.aiRelated);
  }
  return map;
}

async function queueDepth(name = ANALYZE_QUEUE) {
  try {
    const q = new QueueClient(CONN(), name);
    const props = await q.getProperties();
    return props.approximateMessagesCount ?? null;
  } catch {
    return null; // never let a health probe take down the API
  }
}

// Chunked, size-guarded write. See lib/tablesafe.js — the previous
// `.slice(0, 60_000)` blew the 32,768-character property ceiling, which is what
// aborted the rollup at its first large section.
async function saveAggregate(metric, period, payload) {
  const { props, dropped } = tablesafe.packJson(payload);
  await aggTable().upsertEntity(
    {
      partitionKey: metric,
      rowKey: period,
      ...props,
      truncated: dropped.length ? dropped.join(',') : '',
      updatedAt: new Date().toISOString()
    },
    'Replace' // Replace (not Merge) so stale chunk properties never linger
  );
  return { dropped };
}

async function listAggregates(metric) {
  const out = [];
  const iter = aggTable().listEntities({
    queryOptions: { filter: `PartitionKey eq '${metric}'` }
  });
  for await (const e of iter) {
    const r = tablesafe.unpackJson(e);
    // One corrupt row must not silently vanish, nor abort the listing.
    out.push(r.ok ? { period: e.rowKey, ...r.value } : { period: e.rowKey, error: r.error });
  }
  return out.sort((a, b) => (a.period < b.period ? -1 : 1));
}

async function getAggregate(metric, period) {
  let e;
  try {
    e = await aggTable().getEntity(metric, period);
  } catch (err) {
    if (err.statusCode === 404) return null;
    throw err;
  }
  const r = tablesafe.unpackJson(e);
  // Surface corruption as a named error rather than throwing: the dashboard
  // renders `error` as "unavailable", which beats taking down the caller.
  return r.ok ? r.value : { error: r.error, failedAt: e.updatedAt || null };
}

async function getRaw(subreddit, createdUtc, postId, kind = 'post') {
  const blobSvc = BlobServiceClient.fromConnectionString(CONN());
  const day = new Date(createdUtc * 1000).toISOString().slice(0, 10);
  const name = `${subreddit.toLowerCase()}/${day}/${rowKeyFor({ id: postId, kind })}.json`;
  const blob = blobSvc.getContainerClient(RAW_CONTAINER).getBlockBlobClient(name);
  const dl = await blob.downloadToBuffer();
  return JSON.parse(dl.toString('utf8'));
}

// Write a JSONL export of all analyzed rows to blob; returns a 24h read SAS URL.
async function writeExport(lines) {
  const blobSvc = BlobServiceClient.fromConnectionString(CONN());
  const container = blobSvc.getContainerClient('exports');
  await container.createIfNotExists();
  const name = `analysis-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.jsonl`;
  const blob = container.getBlockBlobClient(name);
  const body = lines.join('\n');
  await blob.upload(body, Buffer.byteLength(body), {
    blobHTTPHeaders: { blobContentType: 'application/x-ndjson' }
  });
  return blob.generateSasUrl({
    permissions: BlobSASPermissions.parse('r'),
    expiresOn: new Date(Date.now() + 24 * 3600 * 1000)
  });
}

module.exports = {
  ensureInfra,
  upsertPost,
  saveRaw,
  enqueueAnalysis,
  enqueueBackfill,
  saveAnalysis,
  listAnalyzedPosts,
  listCommentTriage,
  listRowsForRetag,
  setContentClass,
  analyzedPostAiFlags,
  getPostRow,
  countPosts,
  queueDepth,
  rowKeyFor,
  kindOf,
  saveAggregate,
  getAggregate,
  listAggregates,
  getRaw,
  writeExport,
  ANALYZE_QUEUE,
  BACKFILL_QUEUE
};
