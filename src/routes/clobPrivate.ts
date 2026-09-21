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
