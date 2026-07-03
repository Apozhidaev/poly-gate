import { type TSchema, Type } from "@sinclair/typebox";
import { strFromU8, unzipSync } from "fflate";
import type { FastifyInstance } from "fastify";
import { rawQueryString, sendUpstream } from "../lib/httpProxy.js";
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

const positionsQuery = Type.Object(
  {
    user: address({ description: "User address (required)" }),
    market: Type.Optional(
      Type.String({ description: "CSV of condition IDs. Mutually exclusive with eventId." }),
    ),
    eventId: Type.Optional(
      Type.String({ description: "CSV of event IDs. Mutually exclusive with market." }),
    ),
    sizeThreshold: Type.Optional(Type.Number({ minimum: 0, default: 1 })),
    redeemable: Type.Optional(Type.Boolean({ default: false })),
    mergeable: Type.Optional(Type.Boolean({ default: false })),
    limit: Type.Optional(Type.Integer({ minimum: 0, maximum: 500, default: 100 })),
    offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000, default: 0 })),
    sortBy: Type.Optional(
      enumU(
        [
          "CURRENT",
          "INITIAL",
          "TOKENS",
          "CASHPNL",
          "PERCENTPNL",
          "TITLE",
          "RESOLVING",
          "PRICE",
          "AVGPRICE",
        ],
        { default: "TOKENS" },
      ),
    ),
    sortDirection: Type.Optional(enumU(["ASC", "DESC"], { default: "DESC" })),
    title: Type.Optional(Type.String({ maxLength: 100 })),
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
    limit: Type.Optional(Type.Integer({ minimum: 0, maximum: 500, default: 20 })),
    minBalance: Type.Optional(Type.Integer({ minimum: 0, maximum: 999999, default: 1 })),
  },
  objOpts,
);

const snapshotQuery = Type.Object({ user: address() }, objOpts);

const snapshotResponse = Type.Object({
  cashBalance: Type.Number(),
  positionsValue: Type.Number(),
  equity: Type.Number(),
  valuationTime: Type.String(),
});

// equity.csv always has exactly two lines: header + one values row.
function parseEquityCsv(text: string) {
  const lines = text.trim().split(/\r?\n/);
  const values = lines[1].split(","); // [cashBalance, positionsValue, equity, valuationTime]
  return {
    cashBalance: Number(values[0]),
    positionsValue: Number(values[1]),
    equity: Number(values[2]),
    valuationTime: values[3],
  };
}

interface DataRoute {
  path: string;
  upstreamPath: string;
  bucket: BucketName;
  summary: string;
  querystring: TSchema;
}

const ROUTES: DataRoute[] = [
  {
    path: "/data/positions",
    upstreamPath: "/positions",
    bucket: "data:positions",
    summary: "Get current positions for a user",
    querystring: positionsQuery,
  },
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
    path: "/data/leaderboard",
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

  app.get(
    "/data/accounting/snapshot",
    {
      schema: {
        tags: ["data"],
        summary: "Get accounting snapshot equity (parsed from equity.csv)",
        description:
          "Downloads the Data API accounting snapshot ZIP, extracts equity.csv and returns it as a JSON object.",
        querystring: snapshotQuery,
        response: {
          200: snapshotResponse,
          502: Type.Object({ error: Type.String() }),
        },
      },
    },
    async (request, reply) => {
      const base = app.gate.config.upstreams.data;
      const url = base + "/v1/accounting/snapshot" + rawQueryString(request);
      const res = await app.gate.httpProxy.forward({
        api: "data",
        bucket: "data:general",
        method: "GET",
        url,
      });
      if (res.status !== 200) {
        sendUpstream(reply, res);
        return;
      }
      try {
        const files = unzipSync(new Uint8Array(res.body));
        const equity = files["equity.csv"];
        if (!equity) throw new Error("equity.csv not found in snapshot");
        return reply.send(parseEquityCsv(strFromU8(equity)));
      } catch (err) {
        return reply.status(502).send({ error: `Failed to read snapshot ZIP: ${String(err)}` });
      }
    },
  );
}
