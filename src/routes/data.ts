import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { forwardPublic } from "./helpers.js";
import type { BucketName } from "../lib/rateLimiter.js";

const looseQuery = Type.Object(
  {},
  { additionalProperties: true, description: "Query params are forwarded 1:1 to Polymarket." },
);

interface DataRoute {
  path: string;
  upstreamPath: string;
  bucket: BucketName;
  summary: string;
}

const ROUTES: DataRoute[] = [
  {
    path: "/data/closed-positions",
    upstreamPath: "/closed-positions",
    bucket: "data:positions",
    summary: "Get closed positions for a user",
  },
  {
    path: "/data/activity",
    upstreamPath: "/activity",
    bucket: "data:general",
    summary: "Get user activity",
  },
  {
    path: "/data/trades",
    upstreamPath: "/trades",
    bucket: "data:trades",
    summary: "Get trades for a user or markets",
  },
  {
    path: "/data/v1/leaderboard",
    upstreamPath: "/v1/leaderboard",
    bucket: "data:general",
    summary: "Get trader leaderboard rankings",
  },
  {
    path: "/data/holders",
    upstreamPath: "/holders",
    bucket: "data:general",
    summary: "Get top holders for markets",
  },
];

export function registerDataRoutes(app: FastifyInstance): void {
  for (const route of ROUTES) {
    app.get(
      route.path,
      {
        schema: {
          tags: ["data"],
          summary: route.summary,
          description: `Proxy of Data API GET ${route.upstreamPath}.`,
          querystring: looseQuery,
        },
      },
      (request, reply) =>
        forwardPublic(app, request, reply, {
          api: "data",
          upstreamPath: route.upstreamPath,
          bucket: route.bucket,
          method: "GET",
        }),
    );
  }

  // Accounting snapshot returns a ZIP (application/zip); passthrough handles binary already.
  app.get(
    "/data/v1/accounting/snapshot",
    {
      schema: {
        tags: ["data"],
        summary: "Download an accounting snapshot (ZIP of CSVs)",
        description: "Proxy of Data API GET /v1/accounting/snapshot. Returns application/zip.",
        querystring: Type.Object(
          { user: Type.String({ description: "User address (0x...)" }) },
          { additionalProperties: true },
        ),
      },
    },
    (request, reply) =>
      forwardPublic(app, request, reply, {
        api: "data",
        upstreamPath: "/v1/accounting/snapshot",
        bucket: "data:general",
        method: "GET",
      }),
  );
}
