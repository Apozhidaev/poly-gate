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
  | "clob:apikey"
  | "clob:markets"
  | "clob:order"
  | "clob:order:post"
  | "clob:order:delete"
  | "clob:orders"
  | "clob:trades"
  | "clob:balance"
  | "data:general"
  | "data:trades"
  | "data:positions"
  | "pnl:general";

const TEN_SECONDS = 10_000;
const TEN_MINUTES = 600_000;
const SAFETY = 0.9;

const scale = (n: number) => Math.max(1, Math.floor(n * SAFETY));

export class RateLimiterRegistry {
  private readonly buckets: Record<BucketName, RateLimiter[]>;
  private readonly enabled: boolean;

  constructor(enabled: boolean) {
    this.enabled = enabled;
    const gammaGeneral = new RateLimiter({
      interval: TEN_SECONDS,
      count: scale(4000),
    });
    const gammaEvents = new RateLimiter({
      interval: TEN_SECONDS,
      count: scale(900),
    });

    const clobGeneral = new RateLimiter({
      interval: TEN_SECONDS,
      count: scale(9000),
    });
    const clobSustained = new RateLimiter({
      interval: TEN_MINUTES,
      count: scale(120_000),
    });
    const clobBooks = new RateLimiter({
      interval: TEN_SECONDS,
      count: scale(500),
    });
    const clobOrder = new RateLimiter({
      interval: TEN_SECONDS,
      count: scale(900),
    });
    const clobOrderPost = new RateLimiter({
      interval: TEN_SECONDS,
      count: scale(5000),
    });
    const clobOrderDelete = new RateLimiter({
      interval: TEN_SECONDS,
      count: scale(5000),
    });
    const clobOrders = new RateLimiter({
      interval: TEN_SECONDS,
      count: scale(500),
    });
    const clobTrades = new RateLimiter({
      interval: TEN_SECONDS,
      count: scale(500),
    });
    const clobBalance = new RateLimiter({
      interval: TEN_SECONDS,
      count: scale(200),
    });
    const clobApiKey = new RateLimiter({
      interval: TEN_SECONDS,
      count: scale(100),
    });

    const dataGeneral = new RateLimiter({
      interval: TEN_SECONDS,
      count: scale(1000),
    });
    const dataTrades = new RateLimiter({
      interval: TEN_SECONDS,
      count: scale(200),
    });
    const dataPositions = new RateLimiter({
      interval: TEN_SECONDS,
      count: scale(150),
    });

    const pnlGeneral = new RateLimiter({
      interval: TEN_SECONDS,
      count: scale(100),
    });
    
    this.buckets = {
      "gamma:general": [gammaGeneral],
      "gamma:events": [gammaEvents, gammaGeneral],
      "clob:books": [clobBooks, clobGeneral],
      "clob:apikey": [clobApiKey, clobGeneral],
      "clob:markets": [clobGeneral],
      "clob:order:post": [clobOrderPost, clobSustained, clobGeneral],
      "clob:order:delete": [clobOrderDelete, clobSustained, clobGeneral],
      "clob:order": [clobOrder, clobGeneral],
      "clob:trades": [clobTrades, clobGeneral],
      "clob:balance": [clobBalance, clobGeneral],
      "clob:orders": [clobOrders, clobGeneral],
      "data:trades": [dataTrades, dataGeneral],
      "data:positions": [dataPositions, dataGeneral],
      "data:general": [dataGeneral],
      "pnl:general": [pnlGeneral],
    };
  }

  /** Runs `fn` through the given bucket (or runs immediately when disabled). */
  async run<T>(bucket: BucketName, fn: () => Promise<T>): Promise<T> {
    if (!this.enabled) return fn();
    await Promise.all(this.buckets[bucket].map((limiter) => limiter.acquire()));
    return fn();
  }
}
