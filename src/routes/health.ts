import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";

export function registerHealthRoutes(app: FastifyInstance): void {
  app.get(
    "/health",
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
}
