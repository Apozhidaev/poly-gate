import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { rawQueryString, sendUpstream } from "../lib/httpProxy.js";
import type { BucketName } from "../lib/rateLimiter.js";

export type Api = "gamma" | "data" | "clob" | "pnl";

export interface ForwardPublicOptions {
  api: Api;
  upstreamPath: string;
  bucket: BucketName;
  method: "GET" | "POST";
  /** Forward the JSON request body upstream (for POST). */
  forwardBody?: boolean;
}

/** Forwards a public request to Polymarket, preserving path/query/body 1:1. */
export async function forwardPublic(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  opts: ForwardPublicOptions,
): Promise<void> {
  const base = app.gate.config.upstreams[opts.api];
  const url = base + opts.upstreamPath + rawQueryString(request);

  const headers: Record<string, string> = {};
  let body: string | undefined;
  if (opts.forwardBody) {
    headers["content-type"] = "application/json";
    body =
      typeof request.body === "string" ? request.body : JSON.stringify(request.body ?? {});
  }

  const res = await app.gate.httpProxy.forward({
    bucket: opts.bucket,
    method: opts.method,
    url,
    body,
    headers,
  });
  sendUpstream(reply, res);
}
