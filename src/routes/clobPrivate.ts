import {
  OrderSide,
  OrderType,
  type SecureClient,
} from "@polymarket/client";
import { fetchBalanceAllowance } from "@polymarket/client/actions";
import { AssetType } from "@polymarket/bindings/clob";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { scheduleClobCall } from "../lib/polymarket/clobCall.js";
import { StringEnum } from "../lib/typebox.js";

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

const makerOrderSchema = Type.Object({
  outcome: Type.String(),
  owner: Type.String(),
  price: Type.String(),
  side: Type.String(),
  assetId: Type.String(),
  tokenId: Type.String({ description: "Deprecated alias of assetId" }),
  feeRateBps: Type.Union([Type.String(), Type.Null()]),
  makerAddress: Type.String(),
  matchedAmount: Type.String(),
  orderId: Type.String(),
});

const clobTradeSchema = Type.Object({
  id: Type.String(),
  outcome: Type.String(),
  owner: Type.String(),
  price: Type.String(),
  side: Type.String(),
  size: Type.String(),
  status: Type.String({ description: "e.g. TRADE_STATUS_CONFIRMED" }),
  conditionId: Type.String(),
  assetId: Type.String(),
  tokenId: Type.String({ description: "Deprecated alias of assetId" }),
  bucketIndex: Type.Number(),
  feeRateBps: Type.String(),
  updatedAt: Type.String({ description: "ISO-8601 timestamp" }),
  makerAddress: Type.String(),
  makerOrders: Type.Array(makerOrderSchema),
  matchedAt: Type.String({ description: "ISO-8601 timestamp" }),
  takerOrderId: Type.String(),
  traderSide: StringEnum(["TAKER", "MAKER"]),
  transactionHash: Type.String(),
});

const userTradesResponseSchema = Type.Object(
  {
    items: Type.Array(clobTradeSchema),
    has_more: Type.Boolean(),
    next_cursor: Type.Optional(Type.String()),
    total_count: Type.Optional(Type.Number()),
  },
  {
    description: "First page of account trades",
    examples: [
      {
        items: [
          {
            id: "d83cf884-38cd-460c-97f7-4a1a8c6b971f",
            outcome: "Yes",
            owner: "0623855e-28bf-b955-b8cd-a77427274647",
            price: "0.83",
            side: "BUY",
            size: "13.09",
            status: "TRADE_STATUS_CONFIRMED",
            conditionId:
              "0xfdfdcbcf9c268407faefe9f0b29743f2aa6e701c5873bba02d87b206b8f9ae2e",
            assetId:
              "13746535053591566747844631539975609003059990422143780703172111994120738569717",
            tokenId:
              "13746535053591566747844631539975609003059990422143780703172111994120738569717",
            bucketIndex: 0,
            feeRateBps: "0",
            updatedAt: "2026-09-21T23:50:53.000Z",
            makerAddress: "0x5bB6De445cDD88d912bA3905fd072AffDC519d57",
            makerOrders: [
              {
                outcome: "Yes",
                owner: "02d10472-a028-a03c-6b71-03a8cd72443e",
                price: "0.83",
                side: "SELL",
                assetId:
                  "13746535053591566747844631539975609003059990422143780703172111994120738569717",
                tokenId:
                  "13746535053591566747844631539975609003059990422143780703172111994120738569717",
                feeRateBps: null,
                makerAddress: "0x460BdF120D096CB6AceF687CC984770288079894",
                matchedAmount: "13.09",
                orderId:
                  "0xf4473df55068d78c32606a785adf602e5362e86dad39f22521a51ee4449ef1d0",
              },
            ],
            matchedAt: "2026-09-21T23:50:45.000Z",
            takerOrderId:
              "0x9d21164cef3cd6fddb9bd3e3d93f4f79ad6892545625773c87e8de334e84aad7",
            traderSide: "TAKER",
            transactionHash:
              "0xab068ce9f46d0736343e04077564aac8143ba0785a17bdda0f0d34548a9a5215",
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
        },
      },
    },
    async (request, reply) => {
      const { client } = requireUser(request);
      const { orderID } = request.params as { orderID: string };
      const result = await scheduleClobCall(
        app.gate,
        () => client.fetchOrder({ orderId: orderID }),
        {
          bucket: "clob:order",
        },
      );
      return reply.send(result);
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
          return {
            items: page.items,
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
