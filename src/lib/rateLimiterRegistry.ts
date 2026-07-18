import Bottleneck from "bottleneck";

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

/** A simple 10s-window bucket. */
function window10s(perTenSeconds: number): Bottleneck {
  const reservoir = scale(perTenSeconds);
  return new Bottleneck({
    reservoir,
    reservoirRefreshAmount: reservoir,
    reservoirRefreshInterval: TEN_SECONDS,
  });
}

/** Burst (10s) limiter chained under a sustained (10min) limiter. */
function burstWithSustained(burstPer10s: number, sustainedPer10min: number): Bottleneck {
  const sustainedReservoir = scale(sustainedPer10min);
  const sustained = new Bottleneck({
    reservoir: sustainedReservoir,
    reservoirRefreshAmount: sustainedReservoir,
    reservoirRefreshInterval: TEN_MINUTES,
  });
  const burst = window10s(burstPer10s);
  burst.chain(sustained);
  return burst;
}

export class RateLimiterRegistry {
  private readonly buckets: Record<BucketName, Bottleneck>;
  private readonly enabled: boolean;

  constructor(enabled: boolean) {
    this.enabled = enabled;
    this.buckets = {
      "gamma:events": window10s(900),
      "gamma:general": window10s(4000),
      "clob:books": window10s(500),
      "clob:order:post": burstWithSustained(5000, 120_000),
      "clob:order:delete": burstWithSustained(5000, 120_000),
      "clob:ledger": window10s(900),
      "clob:data:trades": window10s(500),
      "clob:balance": window10s(200),
      "data:trades": window10s(200),
      "data:positions": window10s(150),
      "data:general": window10s(1000),
      "pnl:general": window10s(100),
    };
  }

  /** Schedules `fn` through the given bucket (or runs immediately when disabled). */
  schedule<T>(bucket: BucketName, fn: () => Promise<T>): Promise<T> {
    if (!this.enabled) return fn();
    return this.buckets[bucket].schedule(fn);
  }

  async disconnectAll(): Promise<void> {
    await Promise.all(Object.values(this.buckets).map((b) => b.disconnect(false)));
  }
}
