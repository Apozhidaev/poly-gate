import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { GatewayAuthError } from "../lib/errors.js";

declare module "fastify" {
  interface FastifyInstance {
    /** preHandler that requires a valid Bearer token and resolves the wallet. */
    requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

function extractBearer(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (!header) return undefined;
  const [scheme, token] = header.split(" ");
  if (!token || scheme.toLowerCase() !== "bearer") return undefined;
  return token.trim();
}

export function registerAuth(app: FastifyInstance): void {
  app.decorate("requireAuth", async (request: FastifyRequest) => {
    if (!app.gate.clients.hasUsers) {
      throw new GatewayAuthError(
        "No wallets configured. Add a user with credentials to config to use private endpoints.",
        503,
      );
    }

    const token = extractBearer(request);
    if (!token) {
      throw new GatewayAuthError("Missing or malformed Authorization: Bearer <token> header", 401);
    }

    const resolved = app.gate.clients.getByToken(token);
    if (!resolved) {
      throw new GatewayAuthError("Invalid gateway token", 401);
    }

    request.polyUser = resolved;
  });
}
