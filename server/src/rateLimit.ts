/**
 * 极简内存限速（按来源 IP）。
 *
 * 用在登录这类"猜 token"的接口上：服务现在通过 Cloudflare Tunnel 公网可达，
 * 不设限速的话别人可以无限次试 token。单进程内存计数足够（本服务就是单进程）。
 *
 * 语义：只统计**失败**次数；一旦成功立即清零。超过阈值后在窗口内直接 429。
 */
interface Bucket {
  failures: number;
  /** 窗口起点 */
  windowStart: number;
  /** 被锁到什么时候（毫秒时间戳） */
  blockedUntil: number;
}

const buckets = new Map<string, Bucket>();

export interface RateLimitOptions {
  /** 统计窗口（毫秒） */
  windowMs?: number;
  /** 窗口内允许的失败次数 */
  maxFailures?: number;
  /** 触发后锁多久 */
  blockMs?: number;
}

const DEFAULTS = { windowMs: 5 * 60_000, maxFailures: 10, blockMs: 10 * 60_000 };

function bucketOf(key: string, now: number, windowMs: number): Bucket {
  let b = buckets.get(key);
  if (!b || now - b.windowStart > windowMs) {
    b = { failures: 0, windowStart: now, blockedUntil: 0 };
    buckets.set(key, b);
  }
  return b;
}

export interface RateLimitState {
  blocked: boolean;
  retryAfterSec: number;
  failures: number;
}

/** 现在是否被限速 */
export function check(key: string, opts: RateLimitOptions = {}): RateLimitState {
  const { windowMs, maxFailures } = { ...DEFAULTS, ...opts };
  const now = Date.now();
  const b = bucketOf(key, now, windowMs);
  if (b.blockedUntil > now) {
    return { blocked: true, retryAfterSec: Math.ceil((b.blockedUntil - now) / 1000), failures: b.failures };
  }
  if (b.failures >= maxFailures) {
    b.blockedUntil = now + DEFAULTS.blockMs;
    return { blocked: true, retryAfterSec: Math.ceil(DEFAULTS.blockMs / 1000), failures: b.failures };
  }
  return { blocked: false, retryAfterSec: 0, failures: b.failures };
}

/** 记一次失败 */
export function recordFailure(key: string, opts: RateLimitOptions = {}): RateLimitState {
  const { windowMs, maxFailures } = { ...DEFAULTS, ...opts };
  const now = Date.now();
  const b = bucketOf(key, now, windowMs);
  b.failures += 1;
  if (b.failures >= maxFailures) b.blockedUntil = now + DEFAULTS.blockMs;
  return check(key, opts);
}

/** 成功后清零 */
export function recordSuccess(key: string): void {
  buckets.delete(key);
}

/** 定期清理过期桶，避免长期运行内存膨胀 */
setInterval(() => {
  const now = Date.now();
  for (const [key, b] of buckets) {
    if (b.blockedUntil < now && now - b.windowStart > DEFAULTS.windowMs) buckets.delete(key);
  }
}, 5 * 60_000).unref();

export function rateLimitSnapshot(): Array<{ key: string; failures: number; blockedUntil: number }> {
  return [...buckets.entries()].map(([key, b]) => ({ key, failures: b.failures, blockedUntil: b.blockedUntil }));
}
