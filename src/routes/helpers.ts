import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Api } from "../config/api.js";
import { rawQueryString, sendUpstream } from "../lib/httpProxy.js";
import type { BucketName } from "../lib/rateLimiter.js";

export type { Api };

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
    api: opts.api,
    bucket: opts.bucket,
    method: opts.method,
    url,
    body,
    headers,
  });
  sendUpstream(reply, res);
}

function isJsonContentType(contentType: string): boolean {
  return contentType.includes("application/json") || contentType.includes("+json");
}

/** Forwards a public request and transforms a JSON 200 response before sending. */
export async function forwardPublicJson(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  opts: ForwardPublicOptions,
  transformJson: (body: unknown) => unknown,
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
    api: opts.api,
    bucket: opts.bucket,
    method: opts.method,
    url,
    body,
    headers,
  });

  if (res.status !== 200 || !isJsonContentType(res.contentType)) {
    sendUpstream(reply, res);
    return;
  }

  try {
    const json = JSON.parse(res.body.toString("utf8")) as unknown;
    return reply.status(200).header("content-type", "application/json").send(transformJson(json));
  } catch (err) {
    return reply.status(502).send({ error: `Failed to transform upstream response: ${String(err)}` });
  }
}
