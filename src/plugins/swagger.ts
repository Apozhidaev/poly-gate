import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import type { FastifyInstance } from "fastify";

export async function registerSwagger(app: FastifyInstance): Promise<void> {
  await app.register(fastifySwagger, {
    openapi: {
      info: {
        title: "Poly-Gate",
        description:
          "Gateway over Polymarket APIs (Gamma, Data, CLOB) with centralized outbound rate limiting, retries and L2 (POLY_1271) auth. Routes mirror Polymarket paths/params 1:1 under an /gamma, /clob or /data prefix.",
        version: "0.1.0",
      },
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            description: "Gateway token (required for private CLOB endpoints and GET /system/creds).",
          },
        },
      },
      tags: [
        { name: "gamma", description: "Gamma API (public)" },
        { name: "clob", description: "CLOB API (public market data + private trading)" },
        { name: "data", description: "Data API (public)" },
        { name: "pnl", description: "User PnL API (public)" },
        { name: "system", description: "Gateway health & meta" },
      ],
    },
  });

  await app.register(fastifySwaggerUi, {
    routePrefix: "/docs",
    uiConfig: { docExpansion: "list", deepLinking: true },
  });
}
