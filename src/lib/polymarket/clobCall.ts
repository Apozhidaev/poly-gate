import { ProfileOverrides } from "../../config/schema.js";
import type { GateContext } from "../../context.js";
import { UpstreamError } from "../errors.js";
import type { BucketName } from "../rateLimiterRegistry.js";
import { withRetry } from "../retry.js";

/**
 * The clob-client-v2 does NOT throw on HTTP errors — it returns `{ error, status? }`.
 * Convert those into UpstreamError so retry + error handling behave consistently.
 */
export function unwrapClobResult<T>(res: T): T {
  if (res && typeof res === "object" && "error" in res && (res as { error?: unknown }).error) {
    const errObj = res as { error?: unknown; status?: unknown };
    const status = typeof errObj.status === "number" ? errObj.status : 500;
    const message =
      typeof errObj.error === "string" ? errObj.error : JSON.stringify(errObj.error);
    throw new UpstreamError(message, { status, body: res });
  }
  return res;
}

export interface ClobCallOptions {
  bucket: BucketName;
  /** Disable retries for non-idempotent calls (POST /clob/order). */
  retryDisabled?: boolean;
  /** Retry overrides for the upstream API. */
  overrides?: ProfileOverrides;
}

/** Schedules an SDK call through the rate limiter + retry, unwrapping SDK error objects. */
export function scheduleClobCall<T>(
  ctx: GateContext,
  fn: () => Promise<T>,
  opts: ClobCallOptions,
): Promise<T> {
  const run = () =>
    ctx.limiter.run(opts.bucket, async () => unwrapClobResult(await fn()));

  return withRetry(run, {
    cfg: ctx.profile.resolve("clob", opts.overrides).retries,
    disabled: opts.retryDisabled,
  });
}
