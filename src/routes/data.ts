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
      Type.String({
        description: "CSV of condition IDs (at most 20). Aliases: condition_id, conditionId.",
      }),
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
    user: Type.Optional(
      address({ description: "Wallet to anchor on. At least one of user/condition required." }),
    ),
    condition: Type.Optional(
      Type.String({
        description: "CSV of condition IDs (at most 20). Aliases: condition_id, conditionId.",
      }),
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
    filter_amount: Type.Optional(
      Type.Number({ minimum: 0, description: "Filter floor; TOKENS = min shares" }),
    ),
    include_archived: Type.Optional(Type.Boolean({ default: false })),
    sort_by: Type.Optional(
      enumU(
        ["CURRENT_VALUE", "PRICE", "TOKENS", "UNREALIZED_PNL", "REALIZED_PNL", "TOTAL_PNL", "TIMESTAMP"],
        { description: "Default follows status (e.g. CURRENT_VALUE for OPEN)." },
      ),
    ),
    sort_direction: Type.Optional(enumU(["ASC", "DESC"], { default: "DESC" })),
    start: Type.Optional(
      Type.Integer({ minimum: 0, description: "Inclusive lower bound on last_event_at" }),
    ),
    end: Type.Optional(
      Type.Integer({ minimum: 0, description: "Inclusive upper bound on last_event_at" }),
    ),
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
      Type.String({
        description: "CSV of condition IDs (at most 20). Aliases: condition_id, conditionId.",
      }),
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

const userPnlQuery = Type.Object(
  {
    user: address({ description: "Proxy wallet. Alias: user_address." }),
    interval: Type.Optional(
      enumU(["max", "all", "1m", "1w", "1d", "12h", "6h"], {
        default: "1d",
        description: "Window; defaults to 1d.",
      }),
    ),
    fidelity: Type.Optional(
      enumU(["1d", "18h", "12h", "3h", "1h"], {
        default: "1h",
        description: "Output grid; defaults to 1h.",
      }),
    ),
  },
  objOpts,
);

const userStatsQuery = Type.Object(
  {
    user: address({ description: "The wallet whose profile stats to return." }),
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

// ---------------------------------------------------------------------------
// Response schemas mirror https://data-api.polymarket.com/v2/openapi.json
// (documentation only — proxy sends raw Buffer and bypasses serialization).
// ---------------------------------------------------------------------------

const nullableNumber = Type.Union([Type.Number(), Type.Null()]);
const nullableInteger = Type.Union([Type.Integer(), Type.Null()]);

const paginationSchema = Type.Object(
  {
    limit: Type.Integer({ minimum: 0, description: "Page size this page was served with." }),
    offset: Type.Integer({
      minimum: 0,
      description: "Running item offset for display; cursor drives the seek.",
    }),
    has_more: Type.Boolean({ description: "Exact: true iff another page exists." }),
    next_cursor: Type.Optional(
      Type.Union([Type.String(), Type.Null()], {
        description: "Opaque signed cursor for the next page; null on the last page.",
      }),
    ),
  },
  {
    description: "Paging envelope: follow next_cursor until null.",
    additionalProperties: true,
  },
);

const positionSchema = Type.Object(
  {
    proxy_wallet: Type.String({ description: "Proxy wallet holding the position." }),
    token_id: Type.String({ description: "Outcome token id." }),
    condition_id: Type.String({ description: "On-chain condition id." }),
    current_size: Type.Number({ description: "CURRENT holding in shares (~0 on CLOSED)." }),
    avg_price: Type.Number({ description: "Weighted-average entry price per share, USDC." }),
    entry_cost_usdc: Type.Number({ description: "Fee-exclusive entry basis." }),
    entry_fees_usdc: Type.Number({ description: "Attributed BUY-fee total (disclosure only)." }),
    total_cost_usdc: Type.Number({ description: "entry_cost_usdc + entry_fees_usdc." }),
    current_price: Type.Number({ description: "Live mark per share, USDC." }),
    current_value: Type.Number({ description: "current_size × current_price, USDC." }),
    total_size: Type.Number({ description: "Lifetime bought shares (WAC denominator)." }),
    realized_pnl: Type.Number({ description: "Cumulative realized PnL, USDC." }),
    unrealized_pnl: Type.Number({ description: "current_value - entry_cost_usdc." }),
    total_pnl: Type.Number({ description: "realized_pnl + unrealized_pnl." }),
    percent_pnl: Type.Number(),
    percent_realized_pnl: Type.Number(),
    status: Type.String({ description: "OPEN, REDEEMABLE, or CLOSED (row actual state)." }),
    redeemable: Type.Boolean(),
    mergeable: Type.Boolean(),
    negative_risk: Type.Boolean(),
    archived: Type.Boolean(),
    title: Type.String(),
    slug: Type.String(),
    icon: Type.String(),
    event_id: Type.String(),
    event_slug: Type.String(),
    outcome: Type.String(),
    outcome_index: Type.Integer({ description: "999 means unlabeled." }),
    opposite_outcome: Type.String(),
    opposite_token_id: Type.String(),
    end_date: Type.String({ description: "YYYY-MM-DD; 1970-01-01 when unknown." }),
    last_event_at: Type.Integer({ description: "Last economics event, epoch seconds." }),
    first_entry_at: Type.Integer({ description: "First acquisition, epoch seconds." }),
    name: Type.String(),
    profile_image: Type.String(),
    verified: Type.Boolean(),
  },
  {
    description: "One position (/v2/positions); uniform across OPEN/REDEEMABLE/CLOSED arms.",
    additionalProperties: true,
  },
);

const activitySchema = Type.Object(
  {
    proxy_wallet: Type.String(),
    timestamp: Type.Integer({ description: "Block timestamp, epoch seconds." }),
    condition_id: Type.String(),
    type: Type.String({ description: "TRADE, SPLIT, MERGE, REDEEM, …" }),
    size: Type.Number({ description: "Share quantity." }),
    usdc_size: Type.Number({ description: "Cash value in USDC." }),
    transaction_hash: Type.String(),
    price: Type.Number({ description: "Price per share USDC; 0 where N/A." }),
    token_id: Type.String(),
    side: Type.String({ description: "BUY or SELL on trade rows; empty otherwise." }),
    outcome_index: Type.Integer(),
    title: Type.String(),
    slug: Type.String(),
    icon: Type.String(),
    event_slug: Type.String(),
    outcome: Type.String(),
    name: Type.String(),
    pseudonym: Type.String(),
    bio: Type.String(),
    profile_image: Type.String(),
    profile_image_optimized: Type.String(),
    is_combo: Type.Optional(Type.Boolean({ description: "Present on V2/V3 combo trade rows." })),
  },
  {
    description: "One activity-feed event (/v2/activity).",
    additionalProperties: true,
  },
);

const tradeSchema = Type.Object(
  {
    proxy_wallet: Type.String(),
    side: Type.String({ description: "BUY or SELL." }),
    token_id: Type.String(),
    condition_id: Type.String(),
    size: Type.Number({ description: "Filled quantity in shares." }),
    price: Type.Number({ description: "Execution price per share, USDC." }),
    timestamp: Type.Integer({ description: "Block timestamp, epoch seconds." }),
    title: Type.String(),
    slug: Type.String(),
    icon: Type.String(),
    event_slug: Type.String(),
    outcome: Type.String(),
    outcome_index: Type.Integer(),
    name: Type.String(),
    pseudonym: Type.String(),
    bio: Type.String(),
    profile_image: Type.String(),
    profile_image_optimized: Type.String(),
    transaction_hash: Type.String(),
  },
  {
    description: "A trade (/v2/trades).",
    additionalProperties: true,
  },
);

const holderSchema = Type.Object(
  {
    proxy_wallet: Type.String(),
    bio: Type.String(),
    token_id: Type.String(),
    pseudonym: Type.String(),
    amount: Type.Number({ description: "Holding in shares (net, or per-side gross with include_pnl)." }),
    display_username_public: Type.Boolean(),
    outcome_index: Type.Integer(),
    name: Type.String(),
    profile_image: Type.String(),
    profile_image_optimized: Type.String(),
    verified: Type.Boolean(),
    avg_price: Type.Optional(nullableNumber),
    current_price: Type.Optional(nullableNumber),
    current_value: Type.Optional(nullableNumber),
    entry_cost_usdc: Type.Optional(nullableNumber),
    realized_pnl: Type.Optional(nullableNumber),
    unrealized_pnl: Type.Optional(nullableNumber),
    total_pnl: Type.Optional(nullableNumber),
  },
  {
    description: "One market holder; PnL fields only when include_pnl=true.",
    additionalProperties: true,
  },
);

const metaHolderSchema = Type.Object(
  {
    token_id: Type.String({ description: "Outcome token this group ranks." }),
    holders: Type.Array(holderSchema, {
      description: "Top holders of that token, amount descending.",
    }),
  },
  {
    description: "One outcome token's holder group (/v2/holders).",
    additionalProperties: true,
  },
);

const leaderboardEntrySchema = Type.Object(
  {
    rank: Type.Integer({ minimum: 0, description: "Competition rank; ties share, next skips." }),
    user_id: Type.String({ description: "The ranked wallet." }),
    pnl: Type.Number({ description: "Window PnL in USDC." }),
    volume: Type.Number({ description: "Both-sides traded volume in shares (not USD)." }),
    user_name: Type.String(),
    profile_image: Type.String(),
    x_username: Type.String(),
    verified: Type.Boolean(),
  },
  {
    description: "One /v2/leaderboard board row.",
    additionalProperties: true,
  },
);

const leaderboardUserEntrySchema = Type.Object(
  {
    user_id: Type.String(),
    pnl: Type.Number(),
    volume: Type.Number(),
    user_name: Type.String(),
    profile_image: Type.String(),
    x_username: Type.String(),
    verified: Type.Boolean(),
    rank_pnl: Type.Optional(nullableInteger),
    rank_volume: Type.Optional(nullableInteger),
  },
  {
    description: "Standing for ?user=; carries both PnL and volume ranks (null = unranked).",
    additionalProperties: true,
  },
);

function pageOf(item: TSchema, description: string) {
  return Type.Object(
    {
      data: Type.Array(item, { description: "The page's rows." }),
      pagination: paginationSchema,
    },
    { description, additionalProperties: true },
  );
}

const positionsPageSchema = pageOf(positionSchema, "`{ data, pagination }` for /v2/positions.");
const activityPageSchema = pageOf(activitySchema, "`{ data, pagination }` for /v2/activity.");
const tradesPageSchema = pageOf(tradeSchema, "`{ data, pagination }` for /v2/trades.");
const holdersPageSchema = pageOf(metaHolderSchema, "`{ data, pagination }` for /v2/holders.");
const leaderboardPageSchema = pageOf(
  leaderboardEntrySchema,
  "`{ data, pagination }` for /v2/leaderboard board.",
);

const leaderboardUserEnvelopeSchema = Type.Object(
  {
    data: Type.Union([leaderboardUserEntrySchema, Type.Null()], {
      description: "One user's standing, or null if unknown.",
    }),
  },
  {
    description: "`{ data }` envelope when ?user= is given (no pagination).",
    additionalProperties: true,
  },
);

const leaderboardResponseSchema = Type.Union(
  [leaderboardPageSchema, leaderboardUserEnvelopeSchema],
  {
    description:
      "Board page, or one standing when ?user= is set (oneOf, matching upstream OpenAPI).",
  },
);

const userPnlPointSchema = Type.Object(
  {
    timestamp: Type.Integer({
      description: "Epoch seconds; amounts below are cumulative through this instant.",
    }),
    source_block: Type.Integer({ description: "Chain block the point was observed at." }),
    realized_market_pnl: Type.Number({ description: "Realized PnL from market positions." }),
    realized_lp_pnl: Type.Number({ description: "Realized PnL from AMM LP activity." }),
    realized_combo_pnl: Type.Number({ description: "Realized PnL from combo positions." }),
    realized_pnl: Type.Number({
      description: "realized_market_pnl + realized_lp_pnl + realized_combo_pnl.",
    }),
    volume: Type.Number({ description: "Cumulative maker-attributed fill shares." }),
    volume_usdc: Type.Number({ description: "Cumulative maker-attributed fill cash, USDC." }),
    trade_count: Type.Integer({ minimum: 0 }),
    unrealized_pnl: Type.Optional(nullableNumber),
    position_pnl: Type.Optional(nullableNumber),
    trade_pnl: Type.Optional(nullableNumber),
    settled_pnl: Type.Optional(nullableNumber),
    economic_pnl: Type.Optional(nullableNumber),
    deposits: Type.Optional(nullableNumber),
    withdrawals: Type.Optional(nullableNumber),
    cashflow_net: Type.Optional(nullableNumber),
    fees: Type.Optional(nullableNumber),
    fees_paid: Type.Optional(nullableNumber),
    fees_refunded: Type.Optional(nullableNumber),
    maker_rebate: Type.Optional(nullableNumber),
    taker_rebate: Type.Optional(nullableNumber),
    reward_income: Type.Optional(nullableNumber),
    yield_income: Type.Optional(nullableNumber),
    referral_income: Type.Optional(nullableNumber),
    sponsored_income: Type.Optional(nullableNumber),
    wallet_income: Type.Optional(nullableNumber),
  },
  {
    description: "One dense cumulative v2 chart point in USDC; null means unavailable, never zero.",
    additionalProperties: true,
  },
);

const userPnlResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        proxy_wallet: Type.String({ description: "The wallet the series was computed for." }),
        interval: Type.String({ description: "Window served (max, all, 1m, 1w, 1d, 12h, 6h)." }),
        fidelity: Type.String({ description: "Grid step (1d, 18h, 12h, 3h, 1h)." }),
        source_fidelity: Type.String({
          description: "Historical source grain (often daily even on a finer grid).",
        }),
        points: Type.Array(userPnlPointSchema, {
          description: "Dense cumulative points on the requested grid, oldest first.",
        }),
      },
      { additionalProperties: true, description: "Complete v2 user-PnL response data." },
    ),
  },
  {
    description: "`{ data }` envelope for /v2/user-pnl (no pagination).",
    additionalProperties: true,
  },
);

const userStatsSchema = Type.Object(
  {
    proxy_wallet: Type.String({ description: "The proxy wallet these lifetime statistics describe." }),
    trades: Type.Integer({ minimum: 0, description: "Distinct markets the wallet traded." }),
    biggest_win: Type.Number({ description: "Largest single resolved win, USDC (0 if none over $1)." }),
    views: Type.Integer({ minimum: 0, description: "Profile view count." }),
    join_date: Type.Optional(
      Type.Union([Type.Integer(), Type.Null()], {
        description: "Epoch seconds, or null when unknown.",
      }),
    ),
    all_time_pnl: Type.Optional(
      Type.Union([userPnlPointSchema, Type.Null()], {
        description: "Newest persisted all-time PnL observation; null if none yet.",
      }),
    ),
  },
  {
    description: "Profile card for one wallet, plus its newest all-time PnL observation.",
    additionalProperties: true,
  },
);

const userStatsResponseSchema = Type.Object(
  {
    data: Type.Union([userStatsSchema, Type.Null()], {
      description: "Profile stats, or null when the wallet is not a known user.",
    }),
  },
  {
    description:
      "`{ data }` for /v2/user-stats. data:null means unknown user; zeros mean known user with no activity.",
    additionalProperties: true,
  },
);

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
  response: TSchema;
}

const ROUTES: DataRoute[] = [
  {
    path: "/data/positions",
    upstreamPath: "/v2/positions",
    bucket: "data:positions",
    summary: "Get positions for a user or market (lifecycle via status)",
    querystring: positionsQuery,
    response: positionsPageSchema,
  },
  {
    path: "/data/activity",
    upstreamPath: "/v2/activity",
    bucket: "data:activity",
    summary: "Get user activity",
    querystring: activityQuery,
    response: activityPageSchema,
  },
  {
    path: "/data/trades",
    upstreamPath: "/v2/trades",
    bucket: "data:trades",
    summary: "Get trades for a user or markets",
    querystring: tradesQuery,
    response: tradesPageSchema,
  },
  {
    path: "/data/leaderboard",
    upstreamPath: "/v2/leaderboard",
    bucket: "data:general",
    summary: "Get trader leaderboard rankings",
    querystring: leaderboardQuery,
    response: leaderboardResponseSchema,
  },
  {
    path: "/data/holders",
    upstreamPath: "/v2/holders",
    bucket: "data:general",
    summary: "Get top holders for markets",
    querystring: holdersQuery,
    response: holdersPageSchema,
  },
  {
    path: "/data/user-pnl",
    upstreamPath: "/v2/user-pnl",
    bucket: "data:general",
    summary: "Get a user's PnL series",
    querystring: userPnlQuery,
    response: userPnlResponseSchema,
  },
  {
    path: "/data/user-stats",
    upstreamPath: "/v2/user-stats",
    bucket: "data:general",
    summary: "Get a user's profile stats",
    querystring: userStatsQuery,
    response: userStatsResponseSchema,
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
          response: {
            200: route.response,
          },
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
