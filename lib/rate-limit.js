"use strict";

function createWindowCounter({ windowMs, max, maxEntries = 10000 }) {
  const entries = new Map();

  function prune(now = Date.now()) {
    if (entries.size < maxEntries) return;
    for (const [key, entry] of entries) {
      if (entry.resetAt <= now) entries.delete(key);
    }
    while (entries.size >= maxEntries) {
      const oldestKey = entries.keys().next().value;
      if (oldestKey === undefined) break;
      entries.delete(oldestKey);
    }
  }

  function consume(key, amount = 1) {
    const now = Date.now();
    prune(now);
    const current = entries.get(key);
    const entry = !current || current.resetAt <= now
      ? { count: 0, resetAt: now + windowMs }
      : current;
    entry.count += amount;
    entries.set(key, entry);
    return {
      allowed: entry.count <= max,
      remaining: Math.max(0, max - entry.count),
      resetAt: entry.resetAt,
      retryAfter: Math.max(1, Math.ceil((entry.resetAt - now) / 1000))
    };
  }

  function reset(key) {
    entries.delete(key);
  }

  return { consume, reset, size: () => entries.size };
}

function rateLimitMiddleware({ counter, key, code, message }) {
  return (req, res, next) => {
    const requestKey = key(req);
    if (!requestKey) return next();
    const result = counter.consume(requestKey);
    res.setHeader("RateLimit-Remaining", String(result.remaining));
    res.setHeader("RateLimit-Reset", String(Math.ceil(result.resetAt / 1000)));
    if (result.allowed) return next();
    res.setHeader("Retry-After", String(result.retryAfter));
    return res.status(429).json({ code, error: message, retryAfter: result.retryAfter });
  };
}

module.exports = { createWindowCounter, rateLimitMiddleware };
