import type { FastifyInstance } from "fastify";
import { ClobClient } from "@polymarket/clob-client-v2";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configSchema } from "../src/config/schema.js";
import { buildServer } from "../src/server.js";

// A valid secp256k1 test private key (well-known Hardhat account #0).
const TEST_PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const TEST_FUNDER = `0x${"b".repeat(40)}`;

function makeConfig(withUser: boolean) {
  return configSchema.parse({
    users: withUser
      ? [
          {
            id: "main",
            token: "test-token-123",
            privateKey: TEST_PK,
            funder: TEST_FUNDER,
            signatureType: 3,
            creds: { apiKey: "k", secret: "s", passphrase: "p" },
          },
        ]
      : [],
    logLevel: "silent",
  });
}

let app: FastifyInstance | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await app?.close();
  app = undefined;
});

describe("server", () => {
  it("serves /system/health without users", async () => {
    app = await buildServer(makeConfig(false));
    const res = await app.inject({ method: "GET", url: "/system/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok", users: 0 });
  });

  it("returns 503 on private route when no users configured", async () => {
    app = await buildServer(makeConfig(false));
    const res = await app.inject({ method: "GET", url: "/clob/order/abc" });
    expect(res.statusCode).toBe(503);
  });

  it("requires a bearer token on private routes", async () => {
    app = await buildServer(makeConfig(true));
    const res = await app.inject({ method: "GET", url: "/clob/order/abc" });
    expect(res.statusCode).toBe(401);
  });

  it("rejects an invalid bearer token", async () => {
    app = await buildServer(makeConfig(true));
    const res = await app.inject({
      method: "GET",
      url: "/clob/order/abc",
      headers: { authorization: "Bearer wrong" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 503 on GET /system/user-creds when no users configured", async () => {
    app = await buildServer(makeConfig(false));
    const res = await app.inject({ method: "GET", url: "/system/user-creds" });
    expect(res.statusCode).toBe(503);
  });

  it("requires a bearer token on GET /system/user-creds", async () => {
    app = await buildServer(makeConfig(true));
    const res = await app.inject({ method: "GET", url: "/system/user-creds" });
    expect(res.statusCode).toBe(401);
  });

  it("returns L2 creds for the authenticated wallet on GET /system/user-creds", async () => {
    app = await buildServer(makeConfig(true));
    const res = await app.inject({
      method: "GET",
      url: "/system/user-creds",
      headers: { authorization: "Bearer test-token-123" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ apiKey: "k", secret: "s", passphrase: "p" });
  });

  it("rejects POST /clob/derive-api-key without privateKey", async () => {
    app = await buildServer(makeConfig(false));
    const res = await app.inject({
      method: "POST",
      url: "/clob/derive-api-key",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("derives L2 creds via POST /clob/derive-api-key", async () => {
    vi.spyOn(ClobClient.prototype, "createOrDeriveApiKey").mockResolvedValue({
      key: "derived-key",
      secret: "derived-secret",
      passphrase: "derived-pass",
    });

    app = await buildServer(makeConfig(false));
    const res = await app.inject({
      method: "POST",
      url: "/clob/derive-api-key",
      payload: { privateKey: TEST_PK },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      apiKey: "derived-key",
      secret: "derived-secret",
      passphrase: "derived-pass",
    });
  });

  it("forwards public gamma requests 1:1 (path + query)", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        seen.push(url);
        return new Response(JSON.stringify({ events: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    app = await buildServer(makeConfig(false));
    const res = await app.inject({ method: "GET", url: "/gamma/events?limit=5&closed=false" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ events: [] });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(
      "https://gamma-api.polymarket.com/events/keyset?limit=5&closed=false",
    );
  });

  it("POST /gamma/events forwards upstream GET and maps events through toPostEvent", async () => {
    const seen: { url: string; method: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        seen.push({ url, method: init?.method ?? "GET" });
        return new Response(
          JSON.stringify({
            events: [
              {
                id: "evt-1",
                startDate: "2026-01-01T00:00:00.000Z",
                markets: [
                  {
                    id: "1",
                    conditionId: "0xabc",
                    active: true,
                    groupItemTitle: "January 15, 2026",
                    groupItemThreshold: 0,
                  },
                ],
              },
            ],
            next_cursor: "abc",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }),
    );

    app = await buildServer(makeConfig(false));
    const res = await app.inject({ method: "POST", url: "/gamma/events?limit=5" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.next_cursor).toBe("abc");
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({
      id: "evt-1",
      relevant: true,
      calendar: true,
      deadline: "2026-01-16T04:59:59.999Z",
    });
    expect(body.events[0].markets[0].deadline).toBe("2026-01-16T04:59:59.999Z");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      url: "https://gamma-api.polymarket.com/events/keyset?limit=5",
      method: "GET",
    });
  });

  it("POST /gamma/events/slug/:slug forwards upstream GET and maps event through toPostEvent", async () => {
    const seen: { url: string; method: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        seen.push({ url, method: init?.method ?? "GET" });
        return new Response(
          JSON.stringify({
            id: "evt-1",
            slug: "test-event",
            startDate: "2026-01-01T00:00:00.000Z",
            markets: [
              {
                id: "1",
                conditionId: "0xabc",
                active: true,
                groupItemTitle: "January 15, 2026",
                groupItemThreshold: 0,
              },
            ],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }),
    );

    app = await buildServer(makeConfig(false));
    const res = await app.inject({
      method: "POST",
      url: "/gamma/events/slug/test-event?include_chat=true",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      id: "evt-1",
      slug: "test-event",
      relevant: true,
      calendar: true,
      deadline: "2026-01-16T04:59:59.999Z",
    });
    expect(body.markets[0].deadline).toBe("2026-01-16T04:59:59.999Z");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      url: "https://gamma-api.polymarket.com/events/slug/test-event?include_chat=true",
      method: "GET",
    });
  });

  it("accepts long event slugs over the default router param limit", async () => {
    const longSlug =
      "how-many-of-these-34-aipac-endorsees-will-lose-their-primaries-through-august-4-primaries-20260702145459068";
    expect(longSlug.length).toBeGreaterThan(100);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(JSON.stringify({ id: "evt-1", slug: longSlug }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    app = await buildServer(makeConfig(false));
    const res = await app.inject({
      method: "POST",
      url: `/gamma/events/slug/${longSlug}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().slug).toBe(longSlug);
  });

  it("forwards public gamma series by id requests 1:1 (path + query)", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        seen.push(url);
        return new Response(JSON.stringify({ id: "42", title: "Test Series" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    app = await buildServer(makeConfig(false));
    const res = await app.inject({
      method: "GET",
      url: "/gamma/series/42?include_chat=true",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: "42", title: "Test Series" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe("https://gamma-api.polymarket.com/series/42?include_chat=true");
  });

  it("forwards public clob market by condition_id requests 1:1 (path)", async () => {
    const conditionId =
      "0xb39e0d31a16bf622c459ebe01708ea08461cef4eb48c103f3ca79f42f060a5e3";
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        seen.push(url);
        return new Response(
          JSON.stringify({ condition_id: conditionId, accepting_orders: true }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }),
    );

    app = await buildServer(makeConfig(false));
    const res = await app.inject({
      method: "GET",
      url: `/clob/markets/${conditionId}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ condition_id: conditionId, accepting_orders: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(`https://clob.polymarket.com/markets/${conditionId}`);
  });

  it("forwards public clob order book requests 1:1 (path + query)", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        seen.push(url);
        return new Response(JSON.stringify({ asset_id: "123", bids: [], asks: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    app = await buildServer(makeConfig(false));
    const res = await app.inject({
      method: "GET",
      url: "/clob/order-book?token_id=123",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ asset_id: "123", bids: [], asks: [] });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe("https://clob.polymarket.com/book?token_id=123");
  });

  it("forwards public data positions requests 1:1 (path + query)", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        seen.push(url);
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    app = await buildServer(makeConfig(false));
    const res = await app.inject({
      method: "GET",
      url: "/data/positions?user=0x56687bf447db6ffa42ffe2204a05edaa20f55839&limit=10",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(
      "https://data-api.polymarket.com/positions?user=0x56687bf447db6ffa42ffe2204a05edaa20f55839&limit=10",
    );
  });

  it("passes through upstream 4xx without retrying", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    app = await buildServer(makeConfig(false));
    const res = await app.inject({ method: "GET", url: "/gamma/events/slug/does-not-exist" });
    expect(res.statusCode).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
