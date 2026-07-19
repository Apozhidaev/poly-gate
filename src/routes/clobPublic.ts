import { type Chain as ClobChain, ClobClient } from "@polymarket/clob-client-v2";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { scheduleClobCall } from "../lib/polymarket/clobCall.js";
import { viemChain } from "../lib/polymarket/clientFactory.js";
import { StringEnum } from "../lib/typebox.js";
import { forwardPublic } from "./helpers.js";

const objOpts = { additionalProperties: true } as const;

const orderBookQuery = Type.Object(
  {
    token_id: Type.String({ description: "Token ID (asset ID)" }),
  },
  objOpts,
);

const deriveApiKeyBody = Type.Object({
  privateKey: Type.String({
    pattern: "^0x[0-9a-fA-F]+$",
    description: "0x-prefixed secp256k1 private key (signer EOA)",
  }),
  nonce: Type.Optional(Type.Integer()),
});

export function registerClobPublicRoutes(app: FastifyInstance): void {
  app.get(
    "/clob/markets/:condition_id",
    {
      schema: {
        tags: ["clob"],
        summary: "Get market by condition ID",
        description:
          "Proxy of CLOB GET /markets/{condition_id}. Returns CLOB market metadata (tokens, tick size, fees, accepting_orders).",
        params: Type.Object({
          condition_id: Type.String({
            pattern: "^0x[a-fA-F0-9]{64}$",
            description: "Market condition ID (0x-prefixed 32-byte hex)",
          }),
        }),
      },
    },
    (request, reply) => {
      const { condition_id } = request.params as { condition_id: string };
      return forwardPublic(app, request, reply, {
        api: "clob",
        upstreamPath: `/markets/${encodeURIComponent(condition_id)}`,
        bucket: "clob:markets",
        method: "GET",
      });
    },
  );

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
    "/clob/derive-api-key",
    {
      schema: {
        tags: ["clob"],
        summary: "Derive L2 API credentials",
        description:
          "Calls Polymarket createOrDeriveApiKey (L1) for the given privateKey. Returns creds to paste into config.",
        body: deriveApiKeyBody,
        response: {
          200: Type.Object({
            apiKey: Type.String(),
            secret: Type.String(),
            passphrase: Type.String(),
          }),
        },
      },
    },
    async (request) => {
      const { privateKey, nonce } = request.body as {
        privateKey: string;
        nonce?: number;
      };
      const { clob, chainId } = app.gate.config.upstreams;

      const account = privateKeyToAccount(privateKey as `0x${string}`);
      const signer = createWalletClient({
        account,
        chain: viemChain(chainId),
        transport: http(),
      });
      const client = new ClobClient({
        host: clob,
        chain: chainId as ClobChain,
        signer,
      });

      const creds = await scheduleClobCall(
        app.gate,
        () => client.createOrDeriveApiKey(nonce),
        { bucket: "clob:apikey", retryDisabled: true },
      );
      return {
        apiKey: creds.key,
        secret: creds.secret,
        passphrase: creds.passphrase,
      };
    },
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
