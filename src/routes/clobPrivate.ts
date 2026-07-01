import {
  AssetType,
  type ClobClient,
  OrderType,
  Side,
  type TickSize,
} from "@polymarket/clob-client-v2";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { scheduleClobCall } from "../lib/polymarket/clobCall.js";
import { StringEnum } from "../lib/typebox.js";

const TICK_SIZES = ["0.1", "0.01", "0.001", "0.0001"] as const;

const orderBodySchema = Type.Object({
  tokenID: Type.String({ description: "Conditional token id" }),
  side: StringEnum(["BUY", "SELL"]),
  orderType: Type.Optional(StringEnum(["GTC", "GTD", "FOK", "FAK"], { default: "GTC" })),
  tickSize: StringEnum(TICK_SIZES),
  negRisk: Type.Boolean(),
  price: Type.Optional(Type.Number({ description: "Required for GTC/GTD; optional for FOK/FAK" })),
  size: Type.Optional(Type.Number({ description: "Required for GTC/GTD (in shares)" })),
  amount: Type.Optional(
    Type.Number({ description: "Required for FOK/FAK (BUY: USDC amount, SELL: shares)" }),
  ),
  expiration: Type.Optional(Type.Number({ description: "Unix seconds, for GTD" })),
});

interface OrderBody {
  tokenID: string;
  side: "BUY" | "SELL";
  orderType?: "GTC" | "GTD" | "FOK" | "FAK";
  tickSize: (typeof TICK_SIZES)[number];
  negRisk: boolean;
  price?: number;
  size?: number;
  amount?: number;
  expiration?: number;
}

function requireUser(request: FastifyRequest): { client: ClobClient } {
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
          "Builds, signs (POLY_1271) and posts an order. High-level body; NOT retried (duplicate risk).",
        security: [{ bearerAuth: [] }],
        body: orderBodySchema,
      },
    },
    async (request, reply) => {
      const { client } = requireUser(request);
      const body = request.body as OrderBody;
      const side = body.side === "BUY" ? Side.BUY : Side.SELL;
      const orderType = (body.orderType ?? "GTC") as OrderType;
      const options = { tickSize: body.tickSize as TickSize, negRisk: body.negRisk };

      const result = await scheduleClobCall(
        app.gate,
        async () => {
          if (orderType === OrderType.FOK || orderType === OrderType.FAK) {
            if (body.amount == null) {
              throw Object.assign(new Error("`amount` is required for FOK/FAK orders"), {
                statusCode: 400,
              });
            }
            return client.createAndPostMarketOrder(
              { tokenID: body.tokenID, price: body.price, amount: body.amount, side },
              options,
              orderType,
            );
          }
          if (body.price == null || body.size == null) {
            throw Object.assign(new Error("`price` and `size` are required for GTC/GTD orders"), {
              statusCode: 400,
            });
          }
          return client.createAndPostOrder(
            {
              tokenID: body.tokenID,
              price: body.price,
              size: body.size,
              side,
              expiration: body.expiration,
            },
            options,
            orderType as OrderType.GTC | OrderType.GTD,
          );
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
      const result = await scheduleClobCall(app.gate, () => client.cancelOrder({ orderID }), {
        bucket: "clob:order:delete",
      });
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
      const result = await scheduleClobCall(app.gate, () => client.getOrder(orderID), {
        bucket: "clob:ledger",
      });
      return reply.send(result);
    },
  );

  app.get(
    "/clob/trades",
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
      const params = {
        id: q.id,
        maker_address: q.maker_address,
        market: q.market,
        asset_id: q.asset_id,
        before: q.before,
        after: q.after,
      };
      const result = await scheduleClobCall(
        app.gate,
        () => client.getTradesPaginated(params, q.next_cursor),
        { bucket: "clob:data:trades" },
      );
      return reply.send(result);
    },
  );

  app.get(
    "/clob/balance-allowance",
    {
      ...auth,
      schema: {
        tags: ["clob"],
        summary: "Get balance & allowance (USDC/collateral or a token)",
        security: [{ bearerAuth: [] }],
        querystring: Type.Object({
          asset_type: StringEnum(["COLLATERAL", "CONDITIONAL"], { default: "COLLATERAL" }),
          token_id: Type.Optional(Type.String({ description: "Required when asset_type=CONDITIONAL" })),
        }),
      },
    },
    async (request, reply) => {
      const { client } = requireUser(request);
      const q = request.query as { asset_type: "COLLATERAL" | "CONDITIONAL"; token_id?: string };
      if (q.asset_type === "CONDITIONAL" && !q.token_id) {
        return reply.status(400).send({ error: "token_id is required when asset_type=CONDITIONAL" });
      }
      const assetType =
        q.asset_type === "CONDITIONAL" ? AssetType.CONDITIONAL : AssetType.COLLATERAL;
      const result = await scheduleClobCall(
        app.gate,
        () => client.getBalanceAllowance({ asset_type: assetType, token_id: q.token_id }),
        { bucket: "clob:balance" },
      );
      return reply.send(result);
    },
  );
}