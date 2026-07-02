import type { FastifyReply, FastifyRequest } from "fastify";
import type { RetryConfig } from "../config/schema.js";
import { UpstreamError } from "./errors.js";
import type { BucketName, RateLimiterRegistry } from "./rateLimiter.js";
import { withRetry } from "./retry.js";

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

interface NormalizedResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

function parseRetryAfter(res: Response): number | undefined {
  const header = res.headers.get("retry-after");
  if (!header) return undefined;
  const asNumber = Number(header);
  if (Number.isFinite(asNumber)) return asNumber;
  const asDate = Date.parse(header);
  if (Number.isFinite(asDate)) return Math.max(0, (asDate - Date.now()) / 1000);
  return undefined;
}

function safeJson(buf: Buffer): unknown {
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    return buf.toString("utf8");
  }
}

export interface ForwardOptions {
  bucket: BucketName;
  method: string;
  /** Fully-qualified upstream URL including query string. */
  url: string;
  /** Raw request body to forward (already serialized). */
  body?: string;
  headers?: Record<string, string>;
  retryDisabled?: boolean;
}

export class HttpProxy {
  constructor(
    private readonly limiter: RateLimiterRegistry,
    private readonly retryCfg: RetryConfig,
    private readonly logger: { warn: (obj: unknown, msg?: string) => void },
    private readonly timeoutMs = 0,
  ) {}

  /** Performs the upstream request with rate limiting + retry, returning the raw response. */
  async forward(opts: ForwardOptions): Promise<NormalizedResponse> {
    const run = () =>
      this.limiter.schedule(opts.bucket, async () => {
        const res = await fetch(opts.url, {
          method: opts.method,
          headers: opts.headers,
          body: opts.body,
          signal: this.timeoutMs > 0 ? AbortSignal.timeout(this.timeoutMs) : undefined,
        });
        const body = Buffer.from(await res.arrayBuffer());
        const contentType = res.headers.get("content-type") ?? "application/octet-stream";

        if (RETRYABLE_STATUS.has(res.status)) {
          throw new UpstreamError(`Upstream returned ${res.status}`, {
            status: res.status,
            retryAfterSeconds: parseRetryAfter(res),
            body: safeJson(body),
          });
        }
        return { status: res.status, contentType, body };
      });

    return withRetry(run, {
      cfg: this.retryCfg,
      disabled: opts.retryDisabled,
      onRetry: ({ attempt, delayMs, error }) =>
        this.logger.warn(
          { bucket: opts.bucket, url: opts.url, attempt, delayMs, err: String(error) },
          "retrying upstream request",
        ),
    });
  }
}

/** Extracts the raw query string (including `?`) from the incoming request, preserving params 1:1. */
export function rawQueryString(request: FastifyRequest): string {
  const url = request.raw.url ?? "";
  const idx = url.indexOf("?");
  return idx === -1 ? "" : url.slice(idx);
}

/** Sends a normalized upstream response back to the client. */
export function sendUpstream(reply: FastifyReply, res: NormalizedResponse): void {
  reply.status(res.status).header("content-type", res.contentType).send(res.body);
}
