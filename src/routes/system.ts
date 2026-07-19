import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";

export function registerSystemRoutes(app: FastifyInstance): void {
  app.get(
    "/system/health",
    {
      schema: {
        tags: ["system"],
        summary: "Gateway health check",
        response: {
          200: Type.Object({
            status: Type.Literal("ok"),
            users: Type.Number({ description: "Number of configured wallets" }),
            uptimeSeconds: Type.Number(),
          }),
        },
      },
    },
    async () => ({
      status: "ok" as const,
      users: app.gate.clients.hasUsers ? app.gate.config.users.length : 0,
      uptimeSeconds: Math.round(process.uptime()),
    }),
  );

  app.get(
    "/system/creds",
    {
      preHandler: app.requireAuth,
      schema: {
        tags: ["system"],
        summary: "Get L2 API credentials",
        description:
          "Returns Polymarket L2 credentials (apiKey, secret, passphrase) for the wallet selected by the Bearer token.",
        security: [{ bearerAuth: [] }],
        response: {
          200: Type.Object({
            apiKey: Type.String(),
            secret: Type.String(),
            passphrase: Type.String(),
          }),
        },
      },
    },
    (request) => {
      const creds = request.polyUser!.config.creds;
      return {
        apiKey: creds.apiKey,
        secret: creds.secret,
        passphrase: creds.passphrase,
      };
    },
  );
}
