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
async function casUpdate(backend, mutate, { retries = 8, baseDelayMs = 5, sleep = defaultSleep, context, label } = {}) {
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
      const delay = baseDelayMs * 2 ** attempt * (0.5 + Math.random() * 0.5);
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
