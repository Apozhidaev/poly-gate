import { RateLimiter } from "./rateLimiter.js";

/**
 * Outbound rate-limit buckets, one per Polymarket endpoint group.
 * Values come from https://docs.polymarket.com/api-reference/rate-limits,
 * scaled to ~90% to keep headroom below Cloudflare throttling.
 */
export type BucketName =
  | "gamma:events"
  | "gamma:general"
  | "clob:books"
  | "clob:order:post"
  | "clob:order:delete"
  | "clob:ledger"
  | "clob:data:trades"
  | "clob:balance"
  | "data:trades"
  | "data:positions"
  | "data:general"
  | "pnl:general";

const TEN_SECONDS = 10_000;
const TEN_MINUTES = 600_000;
const SAFETY = 0.9;

const scale = (n: number) => Math.max(1, Math.floor(n * SAFETY));

const pnlGeneralLimiter = new RateLimiter({
  interval: TEN_SECONDS,
  count: scale(100),
});

export class RateLimiterRegistry {
  private readonly buckets: Record<BucketName, RateLimiter[]>;
  private readonly enabled: boolean;

  constructor(enabled: boolean) {
    this.enabled = enabled;
    const gammaGeneralLimiter = new RateLimiter({
      interval: TEN_SECONDS,
      count: scale(4000),
    });
    const gammaEventsLimiter = new RateLimiter({
      interval: TEN_SECONDS,
      count: scale(900),
    });

    const clobBooksLimiter = new RateLimiter({
      interval: TEN_SECONDS,
      count: scale(500),
    });
    const sustainedClobLimiter = new RateLimiter({
      interval: TEN_MINUTES,
      count: scale(120_000),
    });
    const clobOrderPostLimiter = new RateLimiter({
      interval: TEN_SECONDS,
      count: scale(5000),
    });
    const clobOrderDeleteLimiter = new RateLimiter({
      interval: TEN_SECONDS,
      count: scale(5000),
    });
    const clobLedgerLimiter = new RateLimiter({
      interval: TEN_SECONDS,
      count: scale(900),
    });
    const clobDataTradesLimiter = new RateLimiter({
      interval: TEN_SECONDS,
      count: scale(500),
    });
    const clobBalanceLimiter = new RateLimiter({
      interval: TEN_SECONDS,
      count: scale(200),
    });

    const dataGeneralLimiter = new RateLimiter({
      interval: TEN_SECONDS,
      count: scale(1000),
    });
    const dataTradesLimiter = new RateLimiter({
      interval: TEN_SECONDS,
      count: scale(200),
    });
    const dataPositionsLimiter = new RateLimiter({
      interval: TEN_SECONDS,
      count: scale(150),
    });
    this.buckets = {
      "gamma:events": [gammaEventsLimiter, gammaGeneralLimiter],
      "gamma:general": [gammaGeneralLimiter],
      "clob:books": [clobBooksLimiter],
      "clob:order:post": [clobOrderPostLimiter, sustainedClobLimiter],
      "clob:order:delete": [clobOrderDeleteLimiter, sustainedClobLimiter],
      "clob:ledger": [clobLedgerLimiter],
      "clob:data:trades": [clobDataTradesLimiter],
      "clob:balance": [clobBalanceLimiter],
      "data:trades": [dataTradesLimiter],
      "data:positions": [dataPositionsLimiter],
      "data:general": [dataGeneralLimiter],
      "pnl:general": [pnlGeneralLimiter],
    };
  }

  /** Runs `fn` through the given bucket (or runs immediately when disabled). */
  async run<T>(bucket: BucketName, fn: () => Promise<T>): Promise<T> {
    if (!this.enabled) return fn();
    await Promise.all(this.buckets[bucket].map((limiter) => limiter.acquire()));
    return fn();
  }
}
