import type { FastifyInstance } from "fastify";
import { GatewayAuthError, UpstreamError } from "../lib/errors.js";

/** Maps internal errors to a unified JSON response shape. */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof UpstreamError) {
      // Pass the upstream failure through, preserving its status and body when available.
      const payload =
        error.body && typeof error.body === "object"
          ? error.body
          : { error: error.message, code: error.code, retryAfterSeconds: error.retryAfterSeconds };
      reply.status(error.status).send(payload);
      return;
    }

    if (error instanceof GatewayAuthError) {
      reply.status(error.status).send({ error: error.message });
      return;
    }

    const err = error as Error & { validation?: unknown; statusCode?: number };

    // Fastify validation errors.
    if (err.validation) {
      reply.status(400).send({ error: "Validation error", details: err.message });
      return;
    }

    request.log.error({ err }, "unhandled error");
    const status = err.statusCode ?? 500;
    reply.status(status).send({ error: status === 500 ? "Internal server error" : err.message });
  });
}
