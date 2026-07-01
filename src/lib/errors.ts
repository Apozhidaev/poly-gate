/** Error thrown when an upstream Polymarket API returns a non-2xx response. */
export class UpstreamError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly retryAfterSeconds?: number;
  readonly body?: unknown;

  constructor(
    message: string,
    opts: { status: number; code?: string; retryAfterSeconds?: number; body?: unknown },
  ) {
    super(message);
    this.name = "UpstreamError";
    this.status = opts.status;
    this.code = opts.code;
    this.retryAfterSeconds = opts.retryAfterSeconds;
    this.body = opts.body;
  }
}

/** Error thrown for gateway-level auth problems (missing/invalid Bearer token). */
export class GatewayAuthError extends Error {
  readonly status: number;
  constructor(message: string, status = 401) {
    super(message);
    this.name = "GatewayAuthError";
    this.status = status;
  }
}
