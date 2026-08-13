import { AppError } from './error.js';

/**
 * Simple in-memory sliding-window rate limiter (per process).
 * Good enough for single Render instance; no extra dependency.
 */
export function rateLimit({ windowMs = 60_000, max = 30, keyFn, message } = {}) {
  const hits = new Map();

  function prune(now) {
    for (const [key, times] of hits) {
      const next = times.filter((t) => now - t < windowMs);
      if (next.length) hits.set(key, next);
      else hits.delete(key);
    }
  }

  return (req, res, next) => {
    const now = Date.now();
    if (hits.size > 5000) prune(now);

    const key = (keyFn ? keyFn(req) : req.ip || req.socket?.remoteAddress || 'unknown') || 'unknown';
    const times = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (times.length >= max) {
      return next(
        new AppError(message || 'Too many requests. Please try again later.', 429, 'RATE_LIMITED')
      );
    }
    times.push(now);
    hits.set(key, times);
    next();
  };
}
