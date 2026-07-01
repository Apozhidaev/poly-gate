import { type TSchema, Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import type { BucketName } from "../lib/rateLimiter.js";
import { StringEnum } from "../lib/typebox.js";
import { forwardPublic } from "./helpers.js";

const ADDRESS = "^0x[a-fA-F0-9]{40}$";

const enumU = StringEnum;

const address = (opts?: Record<string, unknown>) =>
  Type.String({ pattern: ADDRESS, description: "0x-prefixed wallet address", ...opts });

// Query schemas mirror https://docs.polymarket.com Data API params 1:1.
// additionalProperties:true keeps any extra/undocumented param passing through
// (routes forward the raw query string regardless).
const objOpts = { additionalProperties: true } as const;

const activityQuery = Type.Object(
  {
    user: address(),
    limit: Type.Optional(Type.Integer({ minimum: 0, maximum: 500, default: 100 })),
    offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000, default: 0 })),
    market: Type.Optional(
      Type.String({ description: "CSV of condition IDs. Mutually exclusive with eventId." }),
    ),
    eventId: Type.Optional(
      Type.String({ description: "CSV of event IDs. Mutually exclusive with market." }),
    ),
    type: Type.Optional(
      Type.String({
        description:
          "CSV of: TRADE, SPLIT, MERGE, REDEEM, REWARD, CONVERSION, DEPOSIT, WITHDRAWAL, YIELD, MAKER_REBATE, TAKER_REBATE, REFERRAL_REWARD",
      }),
    ),
    start: Type.Optional(Type.Integer({ minimum: 0, description: "Lower-bound epoch seconds" })),
    end: Type.Optional(Type.Integer({ minimum: 0, description: "Upper-bound epoch seconds" })),
    sortBy: Type.Optional(enumU(["TIMESTAMP", "TOKENS", "CASH"], { default: "TIMESTAMP" })),
    sortDirection: Type.Optional(enumU(["ASC", "DESC"], { default: "DESC" })),
    side: Type.Optional(enumU(["BUY", "SELL"])),
  },
  objOpts,
);

const closedPositionsQuery = Type.Object(
  {
    user: address(),
    market: Type.Optional(
      Type.String({ description: "CSV of condition IDs. Cannot be used with eventId." }),
    ),
    title: Type.Optional(Type.String({ maxLength: 100, description: "Filter by market title" })),
    eventId: Type.Optional(
      Type.String({ description: "CSV of event IDs. Cannot be used with market." }),
    ),
    limit: Type.Optional(Type.Integer({ minimum: 0, maximum: 50, default: 10 })),
    offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 100000, default: 0 })),
    sortBy: Type.Optional(
      enumU(["REALIZEDPNL", "TITLE", "PRICE", "AVGPRICE", "TIMESTAMP"], { default: "REALIZEDPNL" }),
    ),
    sortDirection: Type.Optional(enumU(["ASC", "DESC"], { default: "DESC" })),
  },
  objOpts,
);

const tradesQuery = Type.Object(
  {
    limit: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000, default: 100 })),
    offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000, default: 0 })),
    takerOnly: Type.Optional(Type.Boolean({ default: true })),
    filterType: Type.Optional(
      enumU(["CASH", "TOKENS"], { description: "Must be provided together with filterAmount." }),
    ),
    filterAmount: Type.Optional(
      Type.Number({ minimum: 0, description: "Must be provided together with filterType." }),
    ),
    market: Type.Optional(
      Type.String({ description: "CSV of condition IDs. Mutually exclusive with eventId." }),
    ),
    eventId: Type.Optional(
      Type.String({ description: "CSV of event IDs. Mutually exclusive with market." }),
    ),
    user: Type.Optional(address()),
    side: Type.Optional(enumU(["BUY", "SELL"])),
  },
  objOpts,
);

const leaderboardQuery = Type.Object(
  {
    category: Type.Optional(
      enumU(
        [
          "OVERALL",
          "POLITICS",
          "SPORTS",
          "ESPORTS",
          "CRYPTO",
          "CULTURE",
          "MENTIONS",
          "WEATHER",
          "ECONOMICS",
          "TECH",
          "FINANCE",
        ],
        { default: "OVERALL" },
      ),
    ),
    timePeriod: Type.Optional(enumU(["DAY", "WEEK", "MONTH", "ALL"], { default: "DAY" })),
    orderBy: Type.Optional(enumU(["PNL", "VOL"], { default: "PNL" })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 25 })),
    offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000, default: 0 })),
    user: Type.Optional(address()),
    userName: Type.Optional(Type.String()),
  },
  objOpts,
);

const holdersQuery = Type.Object(
  {
    market: Type.String({ description: "CSV of condition IDs (required)." }),
    limit: Type.Optional(Type.Integer({ minimum: 0, maximum: 20, default: 20 })),
    minBalance: Type.Optional(Type.Integer({ minimum: 0, maximum: 999999, default: 1 })),
  },
  objOpts,
);

const snapshotQuery = Type.Object({ user: address() }, objOpts);

interface DataRoute {
  path: string;
  upstreamPath: string;
  bucket: BucketName;
  summary: string;
  querystring: TSchema;
}

const ROUTES: DataRoute[] = [
  {
    path: "/data/closed-positions",
    upstreamPath: "/closed-positions",
    bucket: "data:positions",
    summary: "Get closed positions for a user",
    querystring: closedPositionsQuery,
  },
  {
    path: "/data/activity",
    upstreamPath: "/activity",
    bucket: "data:general",
    summary: "Get user activity",
    querystring: activityQuery,
  },
  {
    path: "/data/trades",
    upstreamPath: "/trades",
    bucket: "data:trades",
    summary: "Get trades for a user or markets",
    querystring: tradesQuery,
  },
  {
    path: "/data/v1/leaderboard",
    upstreamPath: "/v1/leaderboard",
    bucket: "data:general",
    summary: "Get trader leaderboard rankings",
    querystring: leaderboardQuery,
  },
  {
    path: "/data/holders",
    upstreamPath: "/holders",
    bucket: "data:general",
    summary: "Get top holders for markets",
    querystring: holdersQuery,
  },
  {
    // Accounting snapshot returns a ZIP (application/zip); passthrough handles binary already.
    path: "/data/v1/accounting/snapshot",
    upstreamPath: "/v1/accounting/snapshot",
    bucket: "data:general",
    summary: "Download an accounting snapshot (ZIP of CSVs)",
    querystring: snapshotQuery,
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
          querystring: route.querystring,
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
}
