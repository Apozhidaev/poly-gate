import { type TSchema, Type } from "@sinclair/typebox";
import { strFromU8, unzipSync } from "fflate";
import type { FastifyInstance } from "fastify";
import { rawQueryString, sendUpstream } from "../lib/httpProxy.js";
import type { BucketName } from "../lib/rateLimiterRegistry.js";
import { StringEnum } from "../lib/typebox.js";
import { forwardPublic } from "./helpers.js";

const ADDRESS = "^0x[a-fA-F0-9]{40}$";

const enumU = StringEnum;

const address = (opts?: Record<string, unknown>) =>
  Type.String({ pattern: ADDRESS, description: "0x-prefixed wallet address", ...opts });

// Query schemas mirror https://docs.polymarket.com Data API v2 params 1:1.
// additionalProperties:true keeps any extra/undocumented param passing through
// (routes forward the raw query string regardless; v2 also accepts camelCase aliases).
const objOpts = { additionalProperties: true } as const;

const activityQuery = Type.Object(
  {
    user: address(),
    limit: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000, default: 100 })),
    cursor: Type.Optional(Type.String({ description: "Opaque pagination cursor from next_cursor" })),
    type: Type.Optional(
      Type.String({
        description:
          "CSV of: TRADE, SPLIT, MERGE, REDEEM, REWARD, CONVERSION, DEPOSIT, WITHDRAWAL, YIELD, MAKER_REBATE, TAKER_REBATE, REFERRAL_REWARD, TIP",
      }),
    ),
    condition: Type.Optional(
      Type.String({ description: "CSV of condition IDs (at most 20). Aliases: condition_id, conditionId." }),
    ),
    event_id: Type.Optional(
      Type.String({ description: "CSV of event IDs (at most 20). Mutually exclusive with condition." }),
    ),
    side: Type.Optional(enumU(["BUY", "SELL"])),
    start: Type.Optional(Type.Integer({ minimum: 0, description: "Lower-bound epoch seconds" })),
    end: Type.Optional(Type.Integer({ minimum: 0, description: "Upper-bound epoch seconds" })),
    sort_by: Type.Optional(enumU(["TIMESTAMP"], { default: "TIMESTAMP" })),
    sort_direction: Type.Optional(enumU(["ASC", "DESC"], { default: "DESC" })),
    exclude_deposits_withdrawals: Type.Optional(Type.Boolean({ default: true })),
  },
  objOpts,
);

const positionsQuery = Type.Object(
  {
    user: Type.Optional(address({ description: "Wallet to anchor on. At least one of user/condition required." })),
    condition: Type.Optional(
      Type.String({ description: "CSV of condition IDs (at most 20). Aliases: condition_id, conditionId." }),
    ),
    event_id: Type.Optional(
      Type.String({ description: "CSV of event IDs (at most 20). User-anchored only." }),
    ),
    status: Type.Optional(
      enumU(["OPEN", "REDEEMABLE", "REDEEMABLE_LOST", "MERGEABLE", "CLOSED"], {
        default: "OPEN",
        description: "Position lifecycle filter; defaults to OPEN.",
      }),
    ),
    limit: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000 })),
    cursor: Type.Optional(Type.String({ description: "Opaque pagination cursor from next_cursor" })),
    title: Type.Optional(Type.String({ description: "Case-insensitive market-title substring filter" })),
    filter_type: Type.Optional(enumU(["CASH", "TOKENS"], { default: "TOKENS" })),
    filter_amount: Type.Optional(Type.Number({ minimum: 0, description: "Filter floor; TOKENS = min shares" })),
    include_archived: Type.Optional(Type.Boolean({ default: false })),
    sort_by: Type.Optional(
      enumU(
        ["CURRENT_VALUE", "PRICE", "TOKENS", "UNREALIZED_PNL", "REALIZED_PNL", "TOTAL_PNL", "TIMESTAMP"],
        { description: "Default follows status (e.g. CURRENT_VALUE for OPEN)." },
      ),
    ),
    sort_direction: Type.Optional(enumU(["ASC", "DESC"], { default: "DESC" })),
    start: Type.Optional(Type.Integer({ minimum: 0, description: "Inclusive lower bound on last_event_at" })),
    end: Type.Optional(Type.Integer({ minimum: 0, description: "Inclusive upper bound on last_event_at" })),
  },
  objOpts,
);

const tradesQuery = Type.Object(
  {
    user: Type.Optional(address()),
    limit: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000 })),
    cursor: Type.Optional(Type.String({ description: "Opaque pagination cursor from next_cursor" })),
    taker_only: Type.Optional(Type.Boolean({ default: true })),
    filter_type: Type.Optional(enumU(["CASH", "TOKENS"], { default: "TOKENS" })),
    filter_amount: Type.Optional(Type.Number({ minimum: 0, description: "Minimum trade size" })),
    condition: Type.Optional(
      Type.String({ description: "CSV of condition IDs (at most 20). Aliases: condition_id, conditionId." }),
    ),
    event_id: Type.Optional(Type.String({ description: "CSV of event IDs (at most 20)." })),
    side: Type.Optional(enumU(["BUY", "SELL"])),
    start: Type.Optional(Type.Integer({ minimum: 0, description: "Window start on block_timestamp" })),
    end: Type.Optional(Type.Integer({ minimum: 0, description: "Window end on block_timestamp" })),
  },
  objOpts,
);

const leaderboardQuery = Type.Object(
  {
    time_period: Type.Optional(enumU(["day", "week", "month", "all"], { default: "day" })),
    category: Type.Optional(
      Type.String({
        default: "overall",
        description: "overall (default), a Gamma market category (e.g. sports), or combos/esports.",
      }),
    ),
    sort_by: Type.Optional(enumU(["PNL", "VOLUME"], { default: "PNL" })),
    user: Type.Optional(address()),
    limit: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000 })),
    cursor: Type.Optional(Type.String({ description: "Opaque pagination cursor from next_cursor" })),
  },
  objOpts,
);

const holdersQuery = Type.Object(
  {
    condition: Type.String({
      description: "CSV of condition IDs (at most 20; required). Aliases: condition_id, conditionId.",
    }),
    limit: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000 })),
    cursor: Type.Optional(Type.String({ description: "Opaque pagination cursor from next_cursor" })),
    min_balance: Type.Optional(Type.Number({ minimum: 0, description: "Minimum net balance in shares" })),
    include_pnl: Type.Optional(Type.Boolean({ default: false })),
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
    upstreamPath: "/v2/positions",
    bucket: "data:positions",
    summary: "Get positions for a user or market (lifecycle via status)",
    querystring: positionsQuery,
  },
  {
    path: "/data/activity",
    upstreamPath: "/v2/activity",
    bucket: "data:activity",
    summary: "Get user activity",
    querystring: activityQuery,
  },
  {
    path: "/data/trades",
    upstreamPath: "/v2/trades",
    bucket: "data:trades",
    summary: "Get trades for a user or markets",
    querystring: tradesQuery,
  },
  {
    path: "/data/leaderboard",
    upstreamPath: "/v2/leaderboard",
    bucket: "data:general",
    summary: "Get trader leaderboard rankings",
    querystring: leaderboardQuery,
  },
  {
    path: "/data/holders",
    upstreamPath: "/v2/holders",
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
        overrides: {
          retries: {
            attempts: 5,
          },
        },
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
