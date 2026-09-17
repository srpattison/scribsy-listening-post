'use strict';

// One boundary for the strategy brief's actual inputs. No question-text
// heuristics: custom questions share this pack and have no dependency map.
const VERSION = 1;
const DEPENDENCIES = ['cohort', 'minbar', 'trust', 'features', 'distributions', 'personas', 'quotes'];

function problem(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length) {
    return { kind: 'cannot-execute', reason: 'Evidence is missing.' };
  }
  if (value.error) return { kind: 'source-error', reason: String(value.error) };
  if (value.degraded || value.unavailable || value._stale || value._truncated) {
    return { kind: 'cannot-execute', reason: value.degradedReason || value._staleReason || 'Evidence is unavailable, stale or incomplete.' };
  }
  return null;
}

function evaluate(evidence, registryHealth) {
  const blockedBy = [];
  for (const section of DEPENDENCIES) {
    const p = problem(evidence[section]);
    if (p) blockedBy.push({ section, ...p });
  }
  const registryProblem = problem(registryHealth);
  if (registryProblem) blockedBy.push({ section: 'boilerplateRegistry', ...registryProblem });
  return { version: VERSION, status: blockedBy.length ? 'blocked' : 'pass', blockedBy };
}

function blockedBrief(gate, questions = []) {
  return {
    answers: [], questions, unavailable: true, degraded: true,
    degradedReason: 'Strategic answers are withheld because required evidence could not be verified.',
    evidenceGate: gate
  };
}

function publishBrief(brief, evidence, registryHealth) {
  const gate = evaluate(evidence, registryHealth);
  if (gate.status === 'blocked') return blockedBrief(gate, brief?.questions || []);
  // Old stored answers predate enforcement. They need a new successful rollup,
  // not merely a currently healthy feature row, before being publishable.
  if (brief?.evidenceGate?.version !== VERSION || brief.evidenceGate.status !== 'pass') {
    return blockedBrief({ version: VERSION, status: 'blocked', blockedBy: [
      { section: 'brief', kind: 'cannot-execute', reason: 'No successful evidence-gate receipt; a new rollup is required.' }
    ] }, brief?.questions || []);
  }
  return brief;
}

function publishFeatures(features) {
  const p = problem(features);
  if (!p) return features;
  // Raw degraded fallbacks stay in storage for diagnosis, never in the normal
  // dashboard response. Reconstruct instead of spreading quotes/counts.
  return { featureBoard: [], unavailable: true, degraded: true,
    degradedReason: p.reason, evidenceGate: { version: VERSION, status: 'blocked', blockedBy: [{ section: 'features', ...p }] } };
}

module.exports = { VERSION, DEPENDENCIES, problem, evaluate, blockedBrief, publishBrief, publishFeatures };
