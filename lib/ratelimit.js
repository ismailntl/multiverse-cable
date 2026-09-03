// ---------------------------------------------------------------------------
// Fixed-window rate limiter.
//
// The bid, signup and upload endpoints had no limits at all: a script could
// open thousands of accounts, or hammer /api/bid with a stolen session. Chat
// already limited itself; this generalises it for the money-touching routes.
//
// In-memory and per-process. Behind multiple instances each process enforces
// its own share, which is fine for abuse control; move to a shared counter if
// you ever need exact global limits.
// ---------------------------------------------------------------------------

const buckets = new Map(); // `${name}:${key}` -> number[] (timestamps)

export function check(name, key, { limit, windowMs }) {
  const id = `${name}:${key}`;
  const now = Date.now();
  const hits = (buckets.get(id) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= limit) {
    buckets.set(id, hits);
    const retryAfter = Math.ceil((windowMs - (now - hits[0])) / 1000);
    return { allowed: false, retryAfter: Math.max(1, retryAfter) };
  }
  hits.push(now);
  buckets.set(id, hits);
  return { allowed: true, remaining: limit - hits.length };
}

// Keep the map from growing without bound on a long-running process
setInterval(() => {
  const now = Date.now();
  for (const [id, hits] of buckets) {
    if (!hits.length || now - hits[hits.length - 1] > 3_600_000) buckets.delete(id);
  }
}, 600_000).unref?.();

export const LIMITS = {
  bid: { limit: 20, windowMs: 60_000 },
  signup: { limit: 5, windowMs: 3_600_000 },
  login: { limit: 10, windowMs: 900_000 },
  upload: { limit: 5, windowMs: 3_600_000 },
  dmca: { limit: 10, windowMs: 3_600_000 },
  checkout: { limit: 10, windowMs: 3_600_000 },
  product: { limit: 15, windowMs: 600_000 },
};
