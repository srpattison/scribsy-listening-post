'use strict';

// Azure OpenAI (AI Foundry) REST client — chat completions with JSON schema output.
// Uses the unified v1 surface (…/openai/v1/chat/completions, model = deployment
// name) which serves both gpt-4.x and gpt-5-family deployments. gpt-5-family
// models reject `max_tokens` and non-default temperature, so we send
// `max_completion_tokens` + default temperature, and fall back to `max_tokens`
// if an older deployment rejects the newer parameter.
// Settings: AOAI_ENDPOINT (https://<name>.openai.azure.com), AOAI_KEY,
// AOAI_DEPLOYMENT (default 'chat').

const { TOPICS, STANCES, EXPERIENCE, STANCE_BASIS, DEALBREAKER_KINDS } = require('./taxonomy');

function cfg() {
  const endpoint = process.env.AOAI_ENDPOINT;
  const key = process.env.AOAI_KEY;
  if (!endpoint || !key) throw new Error('AOAI_ENDPOINT / AOAI_KEY not configured');
  return {
    endpoint: endpoint.replace(/\/+$/, ''),
    key,
    deployment: process.env.AOAI_DEPLOYMENT || 'chat'
  };
}

async function chatJson(system, user, schemaName, schema, maxTokens = 1200) {
  const c = cfg();
  const url = `${c.endpoint}/openai/v1/chat/completions`;
  const body = {
    model: c.deployment,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    max_completion_tokens: maxTokens,
    response_format: {
      type: 'json_schema',
      json_schema: { name: schemaName, strict: true, schema }
    }
  };
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'api-key': c.key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (res.status === 429 || res.status >= 500) {
      lastErr = `${res.status} ${await res.text()}`;
      await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
      continue;
    }
    if (!res.ok) {
      const txt = await res.text();
      if (res.status === 400 && txt.includes('max_completion_tokens') && body.max_completion_tokens) {
        // older deployment: swap to max_tokens once and retry
        body.max_tokens = body.max_completion_tokens;
        delete body.max_completion_tokens;
        continue;
      }
      throw new Error(`AOAI ${res.status}: ${txt}`);
    }
    const data = await res.json();
    const content = data.choices && data.choices[0] && data.choices[0].message.content;
    if (!content) throw new Error('AOAI returned empty content');
    return JSON.parse(content);
  }
  throw new Error(`AOAI failed after retries: ${lastErr}`);
}

const ANALYSIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ai_related: { type: 'boolean' },
    stance_on_ai: { type: 'string', enum: STANCES },
    persona: {
      type: 'object',
      additionalProperties: false,
      properties: {
        experience: { type: 'string', enum: EXPERIENCE },
        goal: { type: 'string' }
      },
      required: ['experience', 'goal']
    },
    stance_basis: { type: 'array', items: { type: 'string', enum: STANCE_BASIS } },
    stance_intensity: { type: 'integer', minimum: 0, maximum: 3 },
    comment_stance_mix: {
      type: 'object',
      additionalProperties: false,
      properties: Object.fromEntries(STANCES.filter((s) => s !== 'na').map((s) => [s, { type: 'integer' }])),
      required: STANCES.filter((s) => s !== 'na')
    },
    topics: { type: 'array', items: { type: 'string', enum: TOPICS.map((t) => t.slug) } },
    pain_points: { type: 'array', items: { type: 'string' } },
    expected_baseline: { type: 'array', items: { type: 'string' } },
    deal_breakers: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          item: { type: 'string' },
          kind: { type: 'string', enum: DEALBREAKER_KINDS },
          quote: { type: 'string' }
        },
        required: ['item', 'kind', 'quote']
      }
    },
    trust_signals: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          signal: { type: 'string' },
          direction: { type: 'string', enum: ['builds', 'breaks'] },
          quote: { type: 'string' }
        },
        required: ['signal', 'direction', 'quote']
      }
    },
    feature_requests: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          feature: { type: 'string' },
          ai_related: { type: 'boolean' },
          quote: { type: 'string' }
        },
        required: ['feature', 'ai_related', 'quote']
      }
    },
    ethics_concerns: { type: 'array', items: { type: 'string' } },
    tools_mentioned: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tool: { type: 'string' },
          sentiment: { type: 'string', enum: ['positive', 'negative', 'mixed', 'neutral'] },
          switching: { type: 'boolean' },
          context: { type: 'string' }
        },
        required: ['tool', 'sentiment', 'switching', 'context']
      }
    },
    notable_quote: { type: 'string' },
    summary: { type: 'string' }
  },
  required: [
    'ai_related', 'stance_on_ai', 'persona', 'stance_basis', 'stance_intensity',
    'comment_stance_mix', 'topics', 'pain_points', 'expected_baseline', 'deal_breakers',
    'trust_signals', 'feature_requests', 'ethics_concerns', 'tools_mentioned',
    'notable_quote', 'summary'
  ]
};

const ANALYSIS_SYSTEM = `You analyze Reddit discussions from writing communities for a market-research tool.
The client builds an editor for creative writers whose core promise is provenance: it can prove the author wrote their manuscript themselves. You are mapping how writers (professional, hobbyist, aspiring) actually talk about AI in their craft — their ethics concerns, boundaries, workflows, pain points, and what tooling they wish existed.
Rules:
- ai_related = true only if the post or its comments substantively discuss AI/LLMs in relation to writing.
- stance_on_ai reflects the ORIGINAL POSTER's overall stance ('na' if not AI-related or indeterminate).
- stance_basis: WHY the OP holds a negative stance (multi-label, only when stance is hostile/wary/conflicted; empty otherwise). Distinguish articulated positions (philosophical-authorship, economic-livelihood, craft-quality, consent-training-data, bad-experience) from social fear (community-pressure) and undirected dread with no argument (vague-doom). Judge from what is actually argued, not what you assume.
- stance_intensity: 0 = not AI-related, 1 = mild opinion, 2 = strong opinion, 3 = emotionally charged / activist energy.
- comment_stance_mix: count each top comment's stance (skip off-topic comments; zeros are fine). This is evidence for majority-vs-loud-minority analysis — count honestly, don't mirror the OP.
- topics: choose every applicable slug from the fixed taxonomy; never invent slugs.
- expected_baseline: capabilities the writer treats as table stakes any serious writing tool must have (short noun phrases) — mentioned as assumptions, not wishes.
- deal_breakers: things whose absence or presence would make the writer refuse or abandon a tool, with kind and a verbatim quote. Only include genuine refuse/abandon signals, not mild preferences.
- trust_signals: things that build or break a writer's trust in a tool or company (e.g. "trains on my manuscript" breaks; "local-only storage" builds), with verbatim quote.
- feature_requests: concrete tooling capabilities people wish existed (normalize the feature name to a short noun phrase, e.g. "AI-usage disclosure log"); ai_related = whether the wished capability itself involves AI; quote must be verbatim from the text.
- pain_points: frustrations with current tools, workflows, or community dynamics (short phrases).
- tools_mentioned: product names only (e.g. Scrivener, ChatGPT, ProWritingAid, Sudowrite), each with the speaker's sentiment toward it, switching = true only if the writer indicates leaving/abandoning/replacing that tool (or refusing it after evaluation), and a one-clause context.
- notable_quote: the single most vivid verbatim sentence capturing the emotional core; empty string if none.
- summary: two sentences, neutral register.`;

async function analyzePost(post, comments) {
  // Engagement counts are deliberately NOT in the prompt. They are an Arctic
  // Shift capture-time snapshot with variable per-row lag, so showing them to
  // the model invites it to reason from what is mostly archiver timing (§3c).
  const commentBlock = comments
    .map((c, i) => `[comment ${i + 1}] ${c.body}`)
    .join('\n')
    .slice(0, 8000);
  const kindLabel = post.kind === 'comment' ? 'COMMENT' : 'POST';
  const src = post.source === 'bluesky'
    ? `BLUESKY (query stream: ${post.subreddit})`
    : `REDDIT r/${post.subreddit}`;
  const user = `SOURCE: ${src}
TITLE: ${post.title}
${kindLabel}:
${(post.selftext || '(link/image post — no body)').slice(0, 6000)}

TOP COMMENTS:
${commentBlock || '(none)'}`;
  const result = await chatJson(ANALYSIS_SYSTEM, user, 'post_analysis', ANALYSIS_SCHEMA, 4000);
  const d = new Date(post.created_utc * 1000);
  // ISO week key, e.g. 2026-W33
  const jan1 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - jan1) / 86400000 + jan1.getUTCDay() + 1) / 7);
  result.week = `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
  return result;
}

const PERSONA_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    personas: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          archetype: { type: 'string' },
          share_pct: { type: 'number' },
          stance_on_ai: { type: 'string' },
          goals: { type: 'array', items: { type: 'string' } },
          fears: { type: 'array', items: { type: 'string' } },
          what_would_win_them: { type: 'string' },
          representative_quote: { type: 'string' }
        },
        required: ['name', 'archetype', 'share_pct', 'stance_on_ai', 'goals', 'fears', 'what_would_win_them', 'representative_quote']
      }
    }
  },
  required: ['personas']
};

async function synthesizePersonas(sampleSummaries, distribution) {
  const system = `You are a product researcher synthesizing audience personas for an editor for creative writers whose differentiator is proving human authorship (provenance ledger). Build 4-6 distinct personas from real Reddit discussion data. Ground every persona in the evidence provided; representative_quote must be selected verbatim from the supplied material. share_pct values should roughly sum to 100.`;
  const user = `OBSERVED DISTRIBUTION (from ${distribution.total} analyzed posts):
Stances: ${JSON.stringify(distribution.stances)}
Experience levels: ${JSON.stringify(distribution.experience)}
Top topics: ${JSON.stringify(distribution.topTopics)}

SAMPLE OF POST SUMMARIES AND QUOTES:
${sampleSummaries.slice(0, 220).map((s) => `- [${s.stance}/${s.experience}] ${s.summary} ${s.quote ? `"${s.quote}"` : ''}`).join('\n').slice(0, 24000)}`;
  return chatJson(system, user, 'personas', PERSONA_SCHEMA, 8000);
}

const FEATURE_NORM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    groups: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          canonical: { type: 'string' },
          members: { type: 'array', items: { type: 'integer' } }
        },
        required: ['canonical', 'members']
      }
    }
  },
  required: ['groups']
};

async function normalizeFeatures(featureNames) {
  const system = 'Cluster near-duplicate feature-request names. Return groups with a canonical short name and the 0-based indexes of member items. Every index appears in exactly one group.';
  const user = featureNames.map((f, i) => `${i}: ${f}`).join('\n').slice(0, 20000);
  return chatJson(system, user, 'feature_groups', FEATURE_NORM_SCHEMA, 6000);
}

const BRIEF_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    answers: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          question: { type: 'string' },
          answer: { type: 'string' },
          confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
          caveats: { type: 'string' },
          evidence: { type: 'array', items: { type: 'string' } }
        },
        required: ['question', 'answer', 'confidence', 'caveats', 'evidence']
      }
    }
  },
  required: ['answers']
};

// Standing research questions — override with STANDING_QUESTIONS app setting
// (JSON array of strings) so they evolve without a redeploy.
const DEFAULT_QUESTIONS = [
  'What are the minimum features writers expect from a serious writing tool, and which ones are deal-breakers when missing?',
  'What loses the trust of writers, and what builds it?',
  'What are the top wishlist items, split into AI-powered and non-AI capabilities?',
  'What are the writer personas post-AI and which dominate? Is there a meaningful "AI-curious but frustrated by no way to safely experiment" cohort?',
  'Are totally anti-AI writers a loud minority or an anxious majority? Is their stance grounded in articulated philosophical/economic positions or in vague doom? Use comment-stance data, distinct-author counts, and stance_basis distributions — do not answer from vibes.'
];

function standingQuestions() {
  try {
    const q = JSON.parse(process.env.STANDING_QUESTIONS || 'null');
    if (Array.isArray(q) && q.length) return q;
  } catch { /* fall through */ }
  return DEFAULT_QUESTIONS;
}

async function strategyBrief(evidencePack) {
  const system = `You are a rigorous product-strategy researcher for an editor for creative writers whose differentiator is provable human authorship (a provenance ledger; the product deliberately cannot generate manuscript text). Answer each standing question strictly from the evidence pack: aggregates first, then verbatim quotes as illustration. State base rates and denominators.
SAMPLING FRAMES — non-negotiable: the corpus mixes two frames with different biases. reddit = largest writer population, skews hobbyist/aspiring and outspoken. bluesky = literary/professional community that skews strongly anti-AI (post-X migration) — treat it as a PR-relevant lens, NEVER as representative of writers overall. Population-level claims (persona dominance, cohort shares, majority/minority) must be made per-frame using the frames data provided; never pool frames for those claims. Cross-frame agreement strengthens a finding; divergence is itself a finding worth reporting.
evidence = short verbatim quotes from the pack. Never invent quotes or numbers.`;
  const user = `STANDING QUESTIONS:\n${standingQuestions().map((q, i) => `${i + 1}. ${q}`).join('\n')}\n\nEVIDENCE PACK (aggregates + samples):\n${JSON.stringify(evidencePack).slice(0, 60000)}`;
  return chatJson(system, user, 'strategy_brief', BRIEF_SCHEMA, 12000);
}

const ASK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    answer: { type: 'string' },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    caveats: { type: 'string' },
    evidence: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          quote: { type: 'string' },
          permalink: { type: 'string' }
        },
        required: ['quote', 'permalink']
      }
    }
  },
  required: ['answer', 'confidence', 'caveats', 'evidence']
};

async function askCorpus(question, aggregates, sampleRows) {
  const system = `You answer ad-hoc research questions about how writers talk about their craft and AI, strictly from the supplied corpus extracts (aggregates + per-post rows with permalinks). Cite verbatim quotes with their permalinks in evidence. Say plainly when the corpus cannot answer the question, and flag Reddit sampling bias where it matters.`;
  const user = `QUESTION: ${question}\n\nAGGREGATES:\n${JSON.stringify(aggregates).slice(0, 20000)}\n\nPER-POST ROWS (score-ranked sample):\n${JSON.stringify(sampleRows).slice(0, 45000)}`;
  return chatJson(system, user, 'corpus_answer', ASK_SCHEMA, 10000);
}

// ---- Embeddings (listening-post index ONLY — a third, isolated embedding
// system; do not conflate with product RAG (Gemini) or the Brain (Voyage)) ----
// 256-dim Matryoshka truncation of text-embedding-3-small: small enough to
// store per-row in Table Storage and scan in-memory at this corpus scale.
const EMBED_DIMS = 256;

async function embedTexts(texts) {
  const c = cfg();
  const deployment = process.env.EMBED_DEPLOYMENT || 'embed';
  const res = await fetch(`${c.endpoint}/openai/v1/embeddings`, {
    method: 'POST',
    headers: { 'api-key': c.key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: deployment, input: texts, dimensions: EMBED_DIMS })
  });
  if (!res.ok) throw new Error(`AOAI embeddings ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.data
    .sort((a, b) => a.index - b.index)
    .map((d) => l2normalize(new Float32Array(d.embedding)));
}

function l2normalize(v) {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

const vecToB64 = (v) => Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64');
const b64ToVec = (b) => {
  const buf = Buffer.from(b, 'base64');
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
};
// Vectors are L2-normalized at embed time, so dot product = cosine similarity.
function cosine(a, b) {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

module.exports = {
  analyzePost, synthesizePersonas, normalizeFeatures, strategyBrief, askCorpus,
  standingQuestions, embedTexts, vecToB64, b64ToVec, cosine, EMBED_DIMS
};
