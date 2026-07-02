import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { StringEnum } from "../lib/typebox.js";
import { forwardPublic } from "./helpers.js";

const userPnlQuery = Type.Object(
  {
    user_address: Type.String({
      pattern: "^0x[a-fA-F0-9]{40}$",
      description: "0x-prefixed wallet address",
    }),
    interval: Type.Optional(StringEnum(["all", "1m", "1w", "1d"], { default: "all" })),
    fidelity: Type.Optional(StringEnum(["1h", "3h", "12h", "1d"], { default: "1h" })),
  },
  { additionalProperties: true },
);

export function registerPnlRoutes(app: FastifyInstance): void {
  app.get(
    "/pnl/user-pnl",
    {
      schema: {
        tags: ["pnl"],
        summary: "Get user PnL timeseries",
        description: "Proxy of user-pnl-api GET /user-pnl (undocumented).",
        querystring: userPnlQuery,
      },
    },
    (request, reply) =>
      forwardPublic(app, request, reply, {
        api: "pnl",
        upstreamPath: "/user-pnl",
        bucket: "pnl:general",
        method: "GET",
      }),
  );
}
