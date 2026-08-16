'use strict';

// Optimistic-concurrency (ETag compare-and-swap) read-modify-write, generic
// over any backend exposing get/put — so it can be exercised against a fake
// backend in tests without mocking the Azure Table SDK (CB-LISTEN-REPO-7 §8n).
//
// `backend` is { get: async () => ({ value, etag }), put: async (value, etag) => void }.
// `put` must reject with an error carrying `.conflict = true` when `etag` no
// longer matches what is stored — exactly Table Storage's 412 (or 409-on-create)
// semantics. `mutate(prevValueOrNull)` returns the next value to write.
//
// Retries on conflict with bounded jittered backoff. After the retry budget is
// exhausted the last conflict error is rethrown, so a caller that cannot
// safely resolve a value fails closed instead of guessing (§8n requirement 2).
async function casUpdate(backend, mutate, { retries = 12, baseDelayMs = 5, maxDelayMs = 500, sleep = defaultSleep, context, label } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const { value, etag } = await backend.get();
    const next = mutate(value);
    try {
      await backend.put(next, etag);
      return next;
    } catch (e) {
      if (!e.conflict || attempt === retries) throw e;
      lastErr = e;
      // Full jitter (AWS's recommended backoff shape): delay is uniform over
      // [0, cap], not just the top half of it. A narrower window (e.g.
      // half-plus-jitter) clusters retries and under heavy contention (dozens
      // of racers on one row) can exhaust the retry budget before every
      // contender serializes — measured directly: 200-way contention with a
      // narrower window occasionally exhausted an 8-retry budget.
      const delay = Math.random() * Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      context?.warn?.(`${label || 'CAS'} conflict, retry ${attempt + 1}/${retries} in ${Math.round(delay)}ms`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { casUpdate };
