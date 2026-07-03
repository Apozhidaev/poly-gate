import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { StringEnum } from "../lib/typebox.js";
import { forwardPublic } from "./helpers.js";

const objOpts = { additionalProperties: true } as const;

const orderBookQuery = Type.Object(
  {
    token_id: Type.String({ description: "Token ID (asset ID)" }),
  },
  objOpts,
);

export function registerClobPublicRoutes(app: FastifyInstance): void {
  app.get(
    "/clob/order-book",
    {
      schema: {
        tags: ["clob"],
        summary: "Get order book",
        description:
          "Proxy of CLOB GET /book. Retrieves the order book summary for a specific token ID (bids, asks, market details, last trade price).",
        querystring: orderBookQuery,
      },
    },
    (request, reply) =>
      forwardPublic(app, request, reply, {
        api: "clob",
        upstreamPath: "/book",
        bucket: "clob:books",
        method: "GET",
      }),
  );

  app.post(
    "/clob/order-books",
    {
      schema: {
        tags: ["clob"],
        summary: "Get order books (request body)",
        description:
          "Proxy of CLOB POST /books. Forwarded directly (not via SDK). Body is an array of { token_id }.",
        body: Type.Array(
          Type.Object(
            {
              token_id: Type.String(),
              side: Type.Optional(StringEnum(["BUY", "SELL"])),
            },
            { additionalProperties: true },
          ),
        ),
      },
    },
    (request, reply) =>
      forwardPublic(app, request, reply, {
        api: "clob",
        upstreamPath: "/books",
        bucket: "clob:books",
        method: "POST",
        forwardBody: true,
      }),
  );
}
