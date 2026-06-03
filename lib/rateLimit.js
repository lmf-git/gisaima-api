/**
 * In-memory fixed-window rate limiter.
 *
 * A single dyno serves every request, so an in-process counter is sufficient and
 * needs no external store; it resets on restart, which is fine for abuse control.
 * (When the deployment ever goes multi-dyno, swap the Map for a shared store like
 * Redis — the call sites stay the same.)
 *
 * Keys are caller-scoped strings (e.g. `uid:<id>` or `ip:<addr>`). Each key gets
 * a rolling window of `windowMs`; up to `limit` hits are allowed per window.
 */

const _windows = new Map(); // key → { count, resetAt }

// Periodically drop expired windows so the Map can't grow unbounded from churn
// of one-off keys (IPs, short-lived guests). unref so it never holds the process
// open on shutdown.
const _sweep = setInterval(() => {
  const now = Date.now();
  for (const [key, w] of _windows) if (w.resetAt <= now) _windows.delete(key);
}, 60_000);
if (_sweep.unref) _sweep.unref();

/**
 * Record a hit against `key`. Returns { allowed, retryAfterMs }.
 * On the limit boundary the request is rejected (allowed=false).
 */
export function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  let w = _windows.get(key);
  if (!w || w.resetAt <= now) {
    w = { count: 0, resetAt: now + windowMs };
    _windows.set(key, w);
  }
  w.count++;
  if (w.count > limit) {
    return { allowed: false, retryAfterMs: w.resetAt - now };
  }
  return { allowed: true, retryAfterMs: 0 };
}

/** Best-effort client IP behind the Heroku router (X-Forwarded-For, first hop). */
export function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return xff.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}
