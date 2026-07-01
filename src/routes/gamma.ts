import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { forwardPublic } from "./helpers.js";

const looseQuery = Type.Object(
  {},
  { additionalProperties: true, description: "Query params are forwarded 1:1 to Polymarket." },
);

export function registerGammaRoutes(app: FastifyInstance): void {
  app.get(
    "/gamma/events/keyset",
    {
      schema: {
        tags: ["gamma"],
        summary: "List events (keyset pagination)",
        description: "Proxy of Gamma GET /events/keyset. Use next_cursor as after_cursor.",
        querystring: looseQuery,
      },
    },
    (request, reply) =>
      forwardPublic(app, request, reply, {
        api: "gamma",
        upstreamPath: "/events/keyset",
        bucket: "gamma:events",
        method: "GET",
      }),
  );

  app.get(
    "/gamma/events/slug/:slug",
    {
      schema: {
        tags: ["gamma"],
        summary: "Get event by slug",
        description: "Proxy of Gamma GET /events/slug/{slug}.",
        params: Type.Object({ slug: Type.String() }),
        querystring: looseQuery,
      },
    },
    (request, reply) => {
      const { slug } = request.params as { slug: string };
      return forwardPublic(app, request, reply, {
        api: "gamma",
        upstreamPath: `/events/slug/${encodeURIComponent(slug)}`,
        bucket: "gamma:events",
        method: "GET",
      });
    },
  );

  app.get(
    "/gamma/public-profile",
    {
      schema: {
        tags: ["gamma"],
        summary: "Get public profile by wallet address",
        description: "Proxy of Gamma GET /public-profile?address=.",
        querystring: Type.Object(
          { address: Type.String({ description: "Wallet address (0x...)" }) },
          { additionalProperties: true },
        ),
      },
    },
    (request, reply) =>
      forwardPublic(app, request, reply, {
        api: "gamma",
        upstreamPath: "/public-profile",
        bucket: "gamma:general",
        method: "GET",
      }),
  );
}
