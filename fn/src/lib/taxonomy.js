'use strict';

// Fixed topic taxonomy — keeps the heatmap stable across runs.
// The analyzer must map every post into these slugs (multi-label).
const TOPICS = [
  { slug: 'ethics-disclosure',        label: 'Ethics: disclosure & honesty' },
  { slug: 'ethics-training-data',     label: 'Ethics: training data & consent' },
  { slug: 'ethics-livelihood',        label: 'Ethics: jobs & livelihood' },
  { slug: 'craft-authenticity',       label: 'Craft: authenticity & voice' },
  { slug: 'craft-skill-atrophy',      label: 'Craft: skill atrophy fears' },
  { slug: 'detection-accusations',    label: 'AI detection & false accusations' },
  { slug: 'community-norms',          label: 'Community norms & backlash' },
  { slug: 'publishing-industry',      label: 'Publishing & platform policy' },
  { slug: 'plagiarism-ownership',     label: 'Plagiarism, ownership & copyright' },
  { slug: 'ai-boundaries',            label: 'Where to draw the AI line' },
  { slug: 'tools-workflow',           label: 'Tools & workflow' },
  { slug: 'brainstorm-worldbuilding', label: 'Brainstorming & worldbuilding' },
  { slug: 'editing-revision',         label: 'Editing & revision' },
  { slug: 'continuity-consistency',   label: 'Continuity & consistency' },
  { slug: 'motivation-blockage',      label: 'Motivation, block & accountability' },
  { slug: 'provenance-proof',         label: 'Proving human authorship' },
  { slug: 'nanowrimo-community',      label: 'NaNoWriMo / November challenges' },
  { slug: 'other',                    label: 'Other' }
];

const STANCES = ['hostile', 'wary', 'conflicted', 'curious', 'pragmatic', 'enthusiastic', 'na'];

const EXPERIENCE = ['professional', 'hobbyist', 'aspiring', 'student', 'unknown'];

// Why someone holds an AI-negative stance (multi-label; empty unless stance is
// hostile/wary/conflicted). Distinguishes grounded positions from vague dread —
// feeds the "philosophical positioning vs doomer fearmongering" question.
const STANCE_BASIS = [
  'philosophical-authorship',  // art/authorship/meaning arguments
  'economic-livelihood',       // jobs, markets, devaluation of writing
  'craft-quality',             // AI output is slop / harms the craft
  'consent-training-data',     // scraping, consent, plagiarism-by-training
  'community-pressure',        // fear of accusations, bans, social backlash
  'bad-experience',            // tried it, it failed them
  'vague-doom'                 // undirected dread, no articulated argument
];

// Deal-breaker kinds — what would make a writer refuse or abandon a tool.
const DEALBREAKER_KINDS = ['missing-feature', 'trust-privacy', 'ai-policy', 'cost', 'platform-lock-in', 'other'];

// NOTE: there is deliberately no DEFAULT_SUBREDDITS here. The subreddit list
// lives in exactly one place in this repo — deploy.sh — and is read from the
// SUBREDDITS app setting at runtime via lib/config.js, which throws if it is
// unset. A second copy in code drifted to 10 entries against a live 23 and
// would have silently ingested the wrong corpus. See CB-LISTEN-REPO-4 §9.1.

// Cheap keyword prefilter for comment triage (zero LLM cost). Used only to
// decide whether a comment is worth paying to analyze — never to decide what a
// row MEANS, and never applied to `community` Bluesky streams, whose whole
// purpose is to sample writers who are not talking about AI.
const AI_PREFILTER = /\b(a\.?i\.?|artificial intelligence|chatgpt|gpt-?\d*|claude|gemini|llm|copilot|sudowrite|novelcrafter|midjourney|generative|genai|machine.?(written|generated)|ai-?(generated|written|assisted|slop|art)|prompt(ing|ed)?|algorithm(ic)?ally generated)\b/i;

// Does this text plausibly discuss AI? Prefilter only — deliberately generous.
function mentionsAi(text) {
  return AI_PREFILTER.test(String(text || ''));
}

// Bump when the analysis schema/prompt changes materially. Rows carry the
// version they were analyzed under; POST /api/reanalyze re-runs older rows
// from the raw archive.
const SCHEMA_VERSION = 3; // v1 base · v2 strategy dims · v3 tool sentiment + embeddings

// Scribsy pillar-resonance keywords (matched against wishes/trust/topics to
// surface posts asking for what Scribsy builds). Tune freely — resonance is
// recomputed at every rollup from stored analysis, no re-analysis needed.
const PILLAR_SIGNALS = {
  provenance: /prov(e|enance|able)|proof|receipt|wrote it (myself|themselves)|human.?(written|authored)|disclosure|attest/i,
  continuity: /continuit|consisten|plot hole|timeline|character (detail|bible)|world.?bible|keep track/i,
  trustLocal: /local.?(only|first)|offline|own(s|ing)? my (data|words|manuscript)|not train|no training|privacy/i,
  safeAI: /safe(ly)? (try|experiment|use)|without (the )?guilt|boundar|dial|control (over|of) (the )?ai/i
};

module.exports = { TOPICS, STANCES, EXPERIENCE, STANCE_BASIS, DEALBREAKER_KINDS, SCHEMA_VERSION, PILLAR_SIGNALS, AI_PREFILTER, mentionsAi };
