import type { RetryConfig } from "../config/schema.js";
import { UpstreamError } from "./errors.js";

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Decides whether a thrown error is worth retrying. */
function isRetryable(err: unknown): boolean {
  if (err instanceof UpstreamError) {
    return RETRYABLE_STATUS.has(err.status);
  }
  // Network-level failures (fetch throws TypeError, undici throws with a code).
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code && ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_SOCKET"].includes(code)) {
      return true;
    }
    if (err.name === "AbortError" || err.name === "TypeError") return true;
  }
  return false;
}

function backoffDelay(attempt: number, cfg: RetryConfig, retryAfterSeconds?: number): number {
  if (retryAfterSeconds != null && Number.isFinite(retryAfterSeconds)) {
    return Math.min(retryAfterSeconds * 1000, cfg.maxDelayMs);
  }
  const raw = cfg.baseDelayMs * cfg.factor ** attempt;
  const capped = Math.min(raw, cfg.maxDelayMs);
  // Full jitter to avoid thundering herd.
  return Math.floor(Math.random() * capped);
}

export interface WithRetryOptions {
  cfg: RetryConfig;
  /** Disable retries for non-idempotent calls (e.g. POST /clob/order). */
  disabled?: boolean;
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

/**
 * Runs `fn`, retrying transient failures with exponential backoff + full jitter.
 * Never retries when `disabled` is true.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: WithRetryOptions): Promise<T> {
  const { cfg, disabled, onRetry } = opts;
  const maxAttempts = disabled || !cfg.enabled ? 0 : cfg.attempts;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt >= maxAttempts || !isRetryable(err)) throw err;
      const retryAfter = err instanceof UpstreamError ? err.retryAfterSeconds : undefined;
      const delayMs = backoffDelay(attempt, cfg, retryAfter);
      onRetry?.({ attempt: attempt + 1, delayMs, error: err });
      await sleep(delayMs);
    }
  }
  throw lastError;
}
