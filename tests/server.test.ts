import type { FastifyInstance } from "fastify";
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
  vi.unstubAllGlobals();
  await app?.close();
  app = undefined;
});

describe("server", () => {
  it("serves /health without users", async () => {
    app = await buildServer(makeConfig(false));
    const res = await app.inject({ method: "GET", url: "/health" });
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
