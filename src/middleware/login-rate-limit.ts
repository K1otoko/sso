export interface RateLimitVerdict {
  allowed: boolean;
  retryAfterSeconds?: number;
}

interface RateLimitEntry {
  failures: number;
  windowStart: number;
}

const DEFAULT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_MAX_FAILURES = 5;
const PRUNE_THRESHOLD = 10_000;

/**
 * 登录失败限速（内存实现，单实例够用）：
 * 同一 IP + 用户名的组合在窗口期内允许有限次失败，超限返回 429。
 */
export class LoginRateLimiter {
  private readonly windowMs: number;
  private readonly maxFailures: number;
  private readonly entries = new Map<string, RateLimitEntry>();

  constructor(options: { windowMs?: number; maxFailures?: number } = {}) {
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.maxFailures = options.maxFailures ?? DEFAULT_MAX_FAILURES;
  }

  check(key: string): RateLimitVerdict {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return { allowed: true };
    }

    const elapsed = Date.now() - entry.windowStart;
    if (elapsed >= this.windowMs) {
      this.entries.delete(key);
      return { allowed: true };
    }

    if (entry.failures >= this.maxFailures) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((this.windowMs - elapsed) / 1000)),
      };
    }

    return { allowed: true };
  }

  recordFailure(key: string): void {
    const entry = this.entries.get(key);
    const now = Date.now();

    if (entry === undefined || now - entry.windowStart >= this.windowMs) {
      this.entries.set(key, { failures: 1, windowStart: now });
    } else {
      entry.failures += 1;
    }

    if (this.entries.size > PRUNE_THRESHOLD) {
      this.prune(now);
    }
  }

  reset(key: string): void {
    this.entries.delete(key);
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (now - entry.windowStart >= this.windowMs) {
        this.entries.delete(key);
      }
    }
  }
}
