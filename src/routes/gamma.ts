import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { forwardPublic } from "./helpers.js";

const objOpts = {
  additionalProperties: true,
  description: "Query params are forwarded 1:1 to Polymarket.",
} as const;

const dateTime = (description?: string) =>
  Type.Optional(Type.String({ format: "date-time", description }));
const intArray = (description?: string) =>
  Type.Optional(Type.Array(Type.Integer(), { description }));
const strArray = (description?: string) =>
  Type.Optional(Type.Array(Type.String(), { description }));

const keysetQuery = Type.Object(
  {
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 500, default: 20, description: "Max results (max 500)" }),
    ),
    order: Type.Optional(
      Type.String({ description: "Comma-separated list of JSON field names to order by" }),
    ),
    ascending: Type.Optional(
      Type.Boolean({ default: true, description: "Sort direction. Only used when order is set." }),
    ),
    after_cursor: Type.Optional(
      Type.String({ description: "Opaque cursor token from a previous response's next_cursor" }),
    ),
    id: intArray(),
    slug: strArray(),
    closed: Type.Optional(Type.Boolean()),
    live: Type.Optional(Type.Boolean()),
    featured: Type.Optional(Type.Boolean()),
    cyom: Type.Optional(Type.Boolean()),
    title_search: Type.Optional(Type.String()),
    liquidity_min: Type.Optional(Type.Number()),
    liquidity_max: Type.Optional(Type.Number()),
    volume_min: Type.Optional(Type.Number()),
    volume_max: Type.Optional(Type.Number()),
    start_date_min: dateTime(),
    start_date_max: dateTime(),
    end_date_min: dateTime(),
    end_date_max: dateTime(),
    start_time_min: dateTime(),
    start_time_max: dateTime(),
    tag_id: intArray(),
    tag_slug: Type.Optional(Type.String()),
    exclude_tag_id: intArray("Tag IDs to exclude. Cannot overlap with tag_id."),
    related_tags: Type.Optional(Type.Boolean()),
    tag_match: Type.Optional(Type.String()),
    series_id: intArray(),
    game_id: intArray(),
    event_date: dateTime(),
    event_week: Type.Optional(Type.Integer()),
    featured_order: Type.Optional(Type.Boolean()),
    recurrence: Type.Optional(Type.String()),
    created_by: strArray(),
    parent_event_id: Type.Optional(Type.Integer()),
    include_children: Type.Optional(Type.Boolean()),
    partner_slug: Type.Optional(
      Type.String({ description: "When set, external_partners are attached to matching events" }),
    ),
    include_chat: Type.Optional(
      Type.Boolean({ description: "When true, includes Chats and Series.Chats relations" }),
    ),
    include_template: Type.Optional(
      Type.Boolean({ description: "When true, includes Templates relation" }),
    ),
    include_best_lines: Type.Optional(
      Type.Boolean({ description: "When true, includes BestLines relation" }),
    ),
    locale: Type.Optional(Type.String()),
  },
  objOpts,
);

const eventBySlugQuery = Type.Object(
  {
    include_chat: Type.Optional(Type.Boolean()),
    include_template: Type.Optional(Type.Boolean()),
  },
  objOpts,
);

const publicProfileQuery = Type.Object(
  {
    address: Type.String({
      pattern: "^0x[a-fA-F0-9]{40}$",
      description: "The wallet address (proxy wallet or user address)",
    }),
  },
  { additionalProperties: true },
);

export function registerGammaRoutes(app: FastifyInstance): void {
  app.get(
    "/gamma/events",
    {
      schema: {
        tags: ["gamma"],
        summary: "List events (keyset pagination)",
        description: "Proxy of Gamma GET /events/keyset. Use next_cursor as after_cursor.",
        querystring: keysetQuery,
      },
    },
    (request, reply) =>
      forwardPublic(app, request, reply, {
        api: "gamma",
        upstreamPath: "/events/keyset",
        bucket: "gamma:events",
        method: "GET",
      }),
  );

  app.get(
    "/gamma/events/slug/:slug",
    {
      schema: {
        tags: ["gamma"],
        summary: "Get event by slug",
        description: "Proxy of Gamma GET /events/slug/{slug}.",
        params: Type.Object({ slug: Type.String() }),
        querystring: eventBySlugQuery,
      },
    },
    (request, reply) => {
      const { slug } = request.params as { slug: string };
      return forwardPublic(app, request, reply, {
        api: "gamma",
        upstreamPath: `/events/slug/${encodeURIComponent(slug)}`,
        bucket: "gamma:events",
        method: "GET",
      });
    },
  );

  app.get(
    "/gamma/public-profile",
    {
      schema: {
        tags: ["gamma"],
        summary: "Get public profile by wallet address",
        description: "Proxy of Gamma GET /public-profile?address=.",
        querystring: publicProfileQuery,
      },
    },
    (request, reply) =>
      forwardPublic(app, request, reply, {
        api: "gamma",
        upstreamPath: "/public-profile",
        bucket: "gamma:general",
        method: "GET",
      }),
  );
}
