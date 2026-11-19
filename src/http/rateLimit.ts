/**
 * Fixed-window, in-memory rate limiter keyed by client IP.
 *
 * On serverless platforms each warm instance has its own memory, so this is a
 * best-effort first line of defence. The authoritative limit should be a
 * platform rule (see SECURITY.md → "Vercel Firewall").
 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  /** Bound memory: never track more than this many keys. */
  private static readonly MAX_KEYS = 10_000;

  constructor(
    readonly limit: number,
    readonly windowMs: number,
  ) {}

  hit(key: string, now = Date.now()) {
    let entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      if (this.hits.size >= RateLimiter.MAX_KEYS) this.sweep(now);
      entry = { count: 0, resetAt: now + this.windowMs };
      this.hits.set(key, entry);
    }
    entry.count++;
    return {
      allowed: entry.count <= this.limit,
      limit: this.limit,
      remaining: Math.max(0, this.limit - entry.count),
      retryAfterSeconds: Math.ceil((entry.resetAt - now) / 1000),
    };
  }

  private sweep(now: number): void {
    for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
    // Still full (e.g. distributed flood): drop the oldest entries.
    if (this.hits.size >= RateLimiter.MAX_KEYS) {
      const excess = this.hits.size - RateLimiter.MAX_KEYS + 1000;
      let i = 0;
      for (const k of this.hits.keys()) {
        if (i++ >= excess) break;
        this.hits.delete(k);
      }
    }
  }
}
