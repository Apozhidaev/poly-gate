import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { StringEnum } from "../lib/typebox.js";
import { forwardPublic } from "./helpers.js";

export function registerClobPublicRoutes(app: FastifyInstance): void {
  app.post(
    "/clob/books",
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
