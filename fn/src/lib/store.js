'use strict';

// Storage helpers: Tables (posts, aggregates), Blob (raw archive), Queue (analysis jobs).
// Everything runs off the function app's own storage connection (AzureWebJobsStorage).

const { TableClient } = require('@azure/data-tables');
const { BlobServiceClient, BlobSASPermissions } = require('@azure/storage-blob');
const { QueueClient } = require('@azure/storage-queue');

const CONN = () => process.env.AzureWebJobsStorage;

const POSTS_TABLE = 'posts';
const AGG_TABLE = 'aggregates';
const RAW_CONTAINER = 'raw';
const ANALYZE_QUEUE = 'analyze-jobs';

function postsTable() {
  return TableClient.fromConnectionString(CONN(), POSTS_TABLE);
}
function aggTable() {
  return TableClient.fromConnectionString(CONN(), AGG_TABLE);
}
function analyzeQueue() {
  return new QueueClient(CONN(), ANALYZE_QUEUE);
}

async function ensureInfra() {
  await postsTable().createTable().catch(swallowExists);
  await aggTable().createTable().catch(swallowExists);
  const blobSvc = BlobServiceClient.fromConnectionString(CONN());
  await blobSvc.getContainerClient(RAW_CONTAINER).createIfNotExists();
  await analyzeQueue().createIfNotExists();
}

function swallowExists(e) {
  if (e.statusCode !== 409) throw e;
}

// Upsert post metadata. Returns true if the post is NEW (needs analysis).
async function upsertPost(post) {
  const table = postsTable();
  const key = { partitionKey: post.subreddit.toLowerCase(), rowKey: post.id };
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
      title: post.title.slice(0, 500),
      author: post.author,
      score: post.score,
      numComments: post.num_comments,
      createdUtc: post.created_utc,
      permalink: post.permalink,
      flair: post.flair || '',
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
  const name = `${post.subreddit.toLowerCase()}/${day}/${post.id}.json`;
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

async function saveAnalysis(subreddit, postId, analysis, { embB64 = '', schemaVersion = 0 } = {}) {
  await postsTable().upsertEntity(
    {
      partitionKey: subreddit.toLowerCase(),
      rowKey: postId,
      analyzed: true,
      schemaVersion,
      emb: embB64,
      analysisJson: JSON.stringify(analysis).slice(0, 30_000),
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

async function saveAggregate(metric, period, payload) {
  await aggTable().upsertEntity(
    {
      partitionKey: metric,
      rowKey: period,
      json: JSON.stringify(payload).slice(0, 60_000),
      updatedAt: new Date().toISOString()
    },
    'Replace'
  );
}

async function listAggregates(metric) {
  const out = [];
  const iter = aggTable().listEntities({
    queryOptions: { filter: `PartitionKey eq '${metric}'` }
  });
  for await (const e of iter) {
    try { out.push({ period: e.rowKey, ...JSON.parse(e.json) }); } catch { /* skip */ }
  }
  return out.sort((a, b) => (a.period < b.period ? -1 : 1));
}

async function getAggregate(metric, period) {
  try {
    const e = await aggTable().getEntity(metric, period);
    return JSON.parse(e.json);
  } catch (e) {
    if (e.statusCode === 404) return null;
    throw e;
  }
}

async function getRaw(subreddit, createdUtc, postId) {
  const blobSvc = BlobServiceClient.fromConnectionString(CONN());
  const day = new Date(createdUtc * 1000).toISOString().slice(0, 10);
  const name = `${subreddit.toLowerCase()}/${day}/${postId}.json`;
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
  saveAnalysis,
  listAnalyzedPosts,
  saveAggregate,
  getAggregate,
  listAggregates,
  getRaw,
  writeExport,
  ANALYZE_QUEUE
};
