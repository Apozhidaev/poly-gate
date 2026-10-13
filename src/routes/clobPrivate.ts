import {
  OrderSide,
  OrderType,
  UnexpectedResponseError,
  type SecureClient,
} from "@polymarket/client";
import { fetchBalanceAllowance } from "@polymarket/client/actions";
import { AssetType } from "@polymarket/bindings/clob";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { UpstreamError } from "../lib/errors.js";
import { scheduleClobCall } from "../lib/polymarket/clobCall.js";
import { StringEnum } from "../lib/typebox.js";
import { parseTrades } from "../lib/userTrade.js";

/** CLOB returns JSON `null` for a missing order; the SDK Zod-parse fails on that. */
function isMissingOrderResponse(err: unknown): boolean {
  if (!(err instanceof UnexpectedResponseError)) return false;
  const issues = (err.cause as { issues?: Array<{ code?: string; received?: unknown; path?: unknown[] }> } | null)
    ?.issues;
  if (
    issues?.some(
      (i) => i.code === "invalid_type" && i.received === "null" && (i.path?.length ?? 0) === 0,
    )
  ) {
    return true;
  }
  return /received null/i.test(err.message);
}

const USDC_DIGITS = 6;

const orderBodySchema = Type.Object({
  tokenID: Type.String({ description: "Conditional token id" }),
  side: StringEnum(["BUY", "SELL"]),
  orderType: Type.Optional(
    StringEnum(["GTC", "GTD", "FOK", "FAK"], { default: "GTC" }),
  ),
  price: Type.Optional(
    Type.Number({ description: "Required for GTC/GTD; optional for FOK/FAK" }),
  ),
  size: Type.Optional(
    Type.Number({ description: "Required for GTC/GTD (in shares)" }),
  ),
  amount: Type.Optional(
    Type.Number({
      description: "Required for FOK/FAK (BUY: USDC amount, SELL: shares)",
    }),
  ),
  expiration: Type.Optional(
    Type.Number({ description: "Unix seconds, for GTD" }),
  ),
});

interface OrderBody {
  tokenID: string;
  side: "BUY" | "SELL";
  orderType?: "GTC" | "GTD" | "FOK" | "FAK";
  price?: number;
  size?: number;
  amount?: number;
  expiration?: number;
}

const mergeBodySchema = Type.Object({
  conditionId: Type.Optional(
    Type.String({ description: "Market condition ID (mutually exclusive with legs)" }),
  ),
  legs: Type.Optional(
    Type.Array(Type.String(), {
      minItems: 1,
      description: "Combo Protocol V2 position IDs (mutually exclusive with conditionId)",
    }),
  ),
  amount: Type.Optional(
    Type.Union([Type.Literal("max"), Type.Number({ exclusiveMinimum: 0 })], {
      default: "max",
      description: '`max` or human share count (converted to base units × 10^6)',
    }),
  ),
  metadata: Type.Optional(Type.String({ description: "Optional transaction metadata" })),
});

interface MergeBody {
  conditionId?: string;
  legs?: string[];
  amount?: "max" | number;
  metadata?: string;
}

const mergeResponseSchema = Type.Object(
  {
    transactionHash: Type.String({ description: "Settled transaction hash" }),
    transactionId: Type.Union([Type.String(), Type.Null()], {
      description: "Polymarket API transaction id when submitted via API; else null",
    }),
  },
  {
    description: "Settled mergePositions outcome",
    examples: [
      {
        transactionHash: "0xabc...",
        transactionId: "tx_123",
      },
    ],
  },
);

function toMergeAmount(amount: "max" | number | undefined): bigint | "max" {
  if (amount == null || amount === "max") return "max";
  return BigInt(Math.round(amount * 10 ** USDC_DIGITS));
}

const acceptedOrderResponseSchema = Type.Object(
  {
    ok: Type.Literal(true),
    orderId: Type.String({ description: "Unique identifier of the placed order" }),
    status: StringEnum(["live", "matched", "delayed"], {
      description: "Placement outcome; fills only exist when status is `matched`",
    }),
    makingAmount: Type.String({
      description: "Maker asset filled at placement; `0` when unmatched",
    }),
    takingAmount: Type.String({
      description: "Taker asset filled at placement; `0` when unmatched",
    }),
    tradeIds: Type.Array(Type.String(), {
      description: "Trade ids created by fills at placement",
    }),
    transactionsHashes: Type.Array(Type.String(), {
      description: "Settlement tx hashes for placement fills (best-effort)",
    }),
  },
  {
    description: "Order accepted by CLOB",
    examples: [
      {
        ok: true,
        orderId: "0xabc...",
        status: "live",
        makingAmount: "0",
        takingAmount: "0",
        tradeIds: [],
        transactionsHashes: [],
      },
    ],
  },
);

const rejectedOrderResponseSchema = Type.Object(
  {
    ok: Type.Literal(false),
    code: StringEnum([
      "unmatched",
      "market_not_ready",
      "insufficient_balance_or_allowance",
      "invalid_nonce",
      "invalid_expiration",
      "post_only_would_cross",
      "post_only_mode",
      "fok_not_filled",
      "fak_not_filled",
      "unknown",
    ]),
    message: Type.String(),
  },
  { description: "Order refused by the venue" },
);

const orderResponseSchema = Type.Union(
  [acceptedOrderResponseSchema, rejectedOrderResponseSchema],
  { description: "Order placement result (discriminated on `ok`)" },
);

const openOrderSchema = Type.Object(
  {
    id: Type.String(),
    outcome: Type.String(),
    owner: Type.String(),
    price: Type.String(),
    side: Type.String({ description: "BUY or SELL" }),
    status: Type.String({ description: "e.g. LIVE, MATCHED, CANCELED" }),
    conditionId: Type.String(),
    assetId: Type.String({ description: "CTF token / position id" }),
    tokenId: Type.String({ description: "Deprecated alias of assetId" }),
    associateTrades: Type.Array(Type.String()),
    createdAt: Type.String({ description: "ISO-8601 timestamp" }),
    makerAddress: Type.String(),
    orderType: Type.String({ description: "e.g. GTC, GTD, FOK, FAK" }),
    originalSize: Type.String(),
    sizeMatched: Type.String(),
    expiresAt: Type.Optional(Type.String({ description: "ISO-8601; GTD only" })),
  },
  {
    description: "Open / resting order from CLOB",
    examples: [
      {
        id: "0x011eb802e7fcdd688a064bdc95f17e6fac3654cfd4ea2c1214cff8d80bb86e50",
        outcome: "Yes",
        owner: "0623855e-28bf-b955-b8cd-a77427274647",
        price: "0.2",
        side: "BUY",
        status: "LIVE",
        conditionId:
          "0xe51b0cdb413eb9a18243e70c1f33705cdab18f4149b867f32f05650e758d8070",
        assetId:
          "90894528034844239433098400057663273138419716408873356788213029508523177653209",
        tokenId:
          "90894528034844239433098400057663273138419716408873356788213029508523177653209",
        associateTrades: [],
        createdAt: "2026-09-22T04:04:44.000Z",
        makerAddress: "0x5bB6De445cDD88d912bA3905fd072AffDC519d57",
        orderType: "GTC",
        originalSize: "5",
        sizeMatched: "0",
      },
    ],
  },
);

const userTradeSchema = Type.Object({
  tradeId: Type.String(),
  orderId: Type.String(),
  conditionId: Type.String(),
  assetId: Type.String(),
  avgPrice: Type.Number(),
  matchedAmount: Type.Number(),
  side: StringEnum(["BUY", "SELL"]),
  matchTime: Type.Number({ description: "Match time as epoch milliseconds" }),
});

const userTradesResponseSchema = Type.Object(
  {
    items: Type.Array(userTradeSchema),
    has_more: Type.Boolean(),
    next_cursor: Type.Optional(Type.String()),
    total_count: Type.Optional(
      Type.Number({ description: "Upstream CLOB trade-row count, not mapped length" }),
    ),
  },
  {
    description: "First page of account trades, mapped to UserTrade rows",
    examples: [
      {
        items: [
          {
            tradeId: "d83cf884-38cd-460c-97f7-4a1a8c6b971f",
            orderId: "0x9d21164cef3cd6fddb9bd3e3d93f4f79ad6892545625773c87e8de334e84aad7",
            conditionId:
              "0xfdfdcbcf9c268407faefe9f0b29743f2aa6e701c5873bba02d87b206b8f9ae2e",
            assetId:
              "13746535053591566747844631539975609003059990422143780703172111994120738569717",
            avgPrice: 0.83,
            matchedAmount: 13.09,
            side: "BUY",
            matchTime: 1726962645000,
          },
        ],
        has_more: false,
      },
    ],
  },
);

function requireUser(request: FastifyRequest): { client: SecureClient } {
  if (!request.polyUser) {
    // Should never happen: requireAuth runs first. Guard for type-safety.
    throw new Error("Authenticated user not resolved");
  }
  return request.polyUser;
}

export function registerClobPrivateRoutes(app: FastifyInstance): void {
  const auth = { preHandler: app.requireAuth };

  app.post(
    "/clob/order",
    {
      ...auth,
      schema: {
        tags: ["clob"],
        summary: "Post a new order",
        description:
          "Builds, signs and posts an order via SecureClient. High-level body; NOT retried (duplicate risk).",
        security: [{ bearerAuth: [] }],
        body: orderBodySchema,
        response: {
          200: orderResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { client } = requireUser(request);
      const body = request.body as OrderBody;
      const side = body.side === "BUY" ? OrderSide.BUY : OrderSide.SELL;
      const orderType = (body.orderType ?? "GTC") as OrderType;

      const result = await scheduleClobCall(
        app.gate,
        async () => {
          if (orderType === OrderType.FOK || orderType === OrderType.FAK) {
            if (body.amount == null) {
              throw Object.assign(
                new Error("`amount` is required for FOK/FAK orders"),
                {
                  statusCode: 400,
                },
              );
            }
            if (side === OrderSide.BUY) {
              return client.placeMarketOrder({
                tokenId: body.tokenID,
                side: OrderSide.BUY,
                amount: body.amount,
                orderType,
                ...(body.price != null ? { maxPrice: body.price } : {}),
              });
            }
            return client.placeMarketOrder({
              tokenId: body.tokenID,
              side: OrderSide.SELL,
              shares: body.amount,
              orderType,
              ...(body.price != null ? { minPrice: body.price } : {}),
            });
          }
          if (body.price == null || body.size == null) {
            throw Object.assign(
              new Error("`price` and `size` are required for GTC/GTD orders"),
              {
                statusCode: 400,
              },
            );
          }
          return client.placeLimitOrder({
            tokenId: body.tokenID,
            side,
            price: body.price,
            size: body.size,
            ...(body.expiration != null ? { expiration: body.expiration } : {}),
          });
        },
        { bucket: "clob:order:post", retryDisabled: true },
      );

      return reply.send(result);
    },
  );

  app.post(
    "/clob/merge",
    {
      ...auth,
      schema: {
        tags: ["clob"],
        summary: "Merge complementary positions into collateral",
        description:
          "Calls SecureClient.mergePositions and waits for on-chain settlement. Provide exactly one of conditionId (market) or legs (combo). NOT retried.",
        security: [{ bearerAuth: [] }],
        body: mergeBodySchema,
        response: {
          200: mergeResponseSchema,
          400: Type.Object({ error: Type.String() }),
        },
      },
    },
    async (request, reply) => {
      const { client } = requireUser(request);
      const body = request.body as MergeBody;
      const hasCondition = body.conditionId != null && body.conditionId !== "";
      const hasLegs = Array.isArray(body.legs) && body.legs.length > 0;
      if (hasCondition === hasLegs) {
        throw Object.assign(
          new Error("Provide exactly one of `conditionId` or `legs`"),
          { statusCode: 400 },
        );
      }

      const amount = toMergeAmount(body.amount);
      const metadata = body.metadata;
      const handle = await scheduleClobCall(
        app.gate,
        () =>
          hasCondition
            ? client.mergePositions({
                conditionId: body.conditionId!,
                amount,
                ...(metadata != null ? { metadata } : {}),
              })
            : client.mergePositions({
                legs: body.legs!,
                amount,
                ...(metadata != null ? { metadata } : {}),
              }),
        { bucket: "clob:order", retryDisabled: true },
      );
      const outcome = await handle.wait();
      return reply.send({
        transactionHash: outcome.transactionHash,
        transactionId: outcome.transactionId,
      });
    },
  );

  app.delete(
    "/clob/order",
    {
      ...auth,
      schema: {
        tags: ["clob"],
        summary: "Cancel single order",
        security: [{ bearerAuth: [] }],
        body: Type.Object({ orderID: Type.String() }),
        response: {
          200: Type.Object(
            {
              canceled: Type.Array(Type.String(), {
                description: "Order ids that were canceled",
              }),
              notCanceled: Type.Record(Type.String(), Type.String(), {
                description:
                  "Map of order id → reason for orders that were not canceled",
              }),
            },
            {
              description: "Cancel result from CLOB",
              examples: [
                {
                  canceled: ["0xf8f6..."],
                  notCanceled: {},
                },
                {
                  canceled: [],
                  notCanceled: {
                    "0xf8f...":
                      "order can't be found - already canceled or matched",
                  },
                },
              ],
            },
          ),
        },
      },
    },
    async (request, reply) => {
      const { client } = requireUser(request);
      const { orderID } = request.body as { orderID: string };
      const result = await scheduleClobCall(
        app.gate,
        () => client.cancelOrder({ orderId: orderID }),
        {
          bucket: "clob:order:delete",
        },
      );
      return reply.send(result);
    },
  );

  app.get(
    "/clob/order/:orderID",
    {
      ...auth,
      schema: {
        tags: ["clob"],
        summary: "Get single order by id",
        security: [{ bearerAuth: [] }],
        params: Type.Object({ orderID: Type.String() }),
        response: {
          200: openOrderSchema,
          404: Type.Object({ error: Type.String() }),
        },
      },
    },
    async (request, reply) => {
      const { client } = requireUser(request);
      const { orderID } = request.params as { orderID: string };
      try {
        const result = await scheduleClobCall(
          app.gate,
          () => client.fetchOrder({ orderId: orderID }),
          {
            bucket: "clob:order",
          },
        );
        if (result == null) {
          throw new UpstreamError("Order not found", {
            status: 404,
            body: { error: "Order not found" },
          });
        }
        return reply.send(result);
      } catch (err) {
        if (isMissingOrderResponse(err)) {
          throw new UpstreamError("Order not found", {
            status: 404,
            body: { error: "Order not found" },
          });
        }
        throw err;
      }
    },
  );

  app.get(
    "/clob/open-orders",
    {
      ...auth,
      schema: {
        tags: ["clob"],
        summary: "Get open orders",
        description: "Returns the wallet's open orders.",
        security: [{ bearerAuth: [] }],
        response: {
          200: Type.Array(openOrderSchema),
        },
      },
    },
    async (request, reply) => {
      const { client } = requireUser(request);
      const result = await scheduleClobCall(
        app.gate,
        async () => {
          const page = await client.listOpenOrders().firstPage();
          return page.items;
        },
        { bucket: "clob:orders" },
      );
      return reply.send(result);
    },
  );

  app.get(
    "/clob/user-trades",
    {
      ...auth,
      schema: {
        tags: ["clob"],
        summary: "Get trades (authenticated user)",
        security: [{ bearerAuth: [] }],
        querystring: Type.Object(
          {
            id: Type.Optional(Type.String()),
            maker_address: Type.Optional(Type.String()),
            market: Type.Optional(Type.String()),
            asset_id: Type.Optional(Type.String()),
            before: Type.Optional(Type.String()),
            after: Type.Optional(Type.String()),
            next_cursor: Type.Optional(Type.String()),
          },
          { additionalProperties: true },
        ),
        response: {
          200: userTradesResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { client } = requireUser(request);
      const q = request.query as Record<string, string | undefined>;
      const result = await scheduleClobCall(
        app.gate,
        async () => {
          const page = await client
            .listAccountTrades({
              id: q.id,
              makerAddress: q.maker_address,
              market: q.market,
              assetId: q.asset_id,
              before: q.before,
              after: q.after,
              cursor: q.next_cursor,
            })
            .firstPage();
          const apiKey = client.credentials.key;
          return {
            items: page.items.flatMap((trade) =>
              parseTrades(trade as unknown as Record<string, unknown>, apiKey),
            ),
            next_cursor: page.nextCursor,
            has_more: page.hasMore,
            total_count: page.totalCount,
          };
        },
        { bucket: "clob:trades" },
      );
      return reply.send(result);
    },
  );

  app.get(
    "/clob/usdc-balance",
    {
      ...auth,
      schema: {
        tags: ["clob"],
        summary: "Get USDC (collateral) balance",
        description: "Returns the wallet's USDC/collateral balance (human-readable units).",
        security: [{ bearerAuth: [] }],
      },
    },
    async (request, reply) => {
      const { client } = requireUser(request);
      const result = await scheduleClobCall(
        app.gate,
        () =>
          fetchBalanceAllowance(client, {
            assetType: AssetType.COLLATERAL,
          }),
        { bucket: "clob:balance" },
      );
      return reply.send({
        balance: Number(result.balance) / 10 ** USDC_DIGITS,
      });
    },
  );

  app.get(
    "/clob/token-balance",
    {
      ...auth,
      schema: {
        tags: ["clob"],
        summary: "Get conditional token balance",
        description:
          "Returns the wallet's balance for a specific conditional token (human-readable units).",
        security: [{ bearerAuth: [] }],
        querystring: Type.Object({
          token_id: Type.String({ description: "Conditional token id" }),
        }),
      },
    },
    async (request, reply) => {
      const { client } = requireUser(request);
      const q = request.query as { token_id: string };
      const result = await scheduleClobCall(
        app.gate,
        () =>
          fetchBalanceAllowance(client, {
            assetType: AssetType.CONDITIONAL,
            tokenId: q.token_id,
          }),
        { bucket: "clob:balance" },
      );
      return reply.send({
        balance: Number(result.balance) / 10 ** USDC_DIGITS,
      });
    },
  );
}
