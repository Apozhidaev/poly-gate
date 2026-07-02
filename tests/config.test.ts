import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/index.js";

function writeConfig(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "poly-gate-"));
  const path = join(dir, "config.yaml");
  writeFileSync(path, content, "utf8");
  return path;
}

describe("loadConfig", () => {
  it("loads with defaults and no users", () => {
    const path = writeConfig("server:\n  port: 9090\n");
    const config = loadConfig(path);
    expect(config.server.port).toBe(9090);
    expect(config.users).toEqual([]);
    expect(config.upstreams.gamma).toContain("gamma-api.polymarket.com");
    expect(config.retries.attempts).toBe(30);
    expect(config.retries.maxElapsedMs).toBe(1_800_000);
  });

  it("parses per-API retry profiles", () => {
    const path = writeConfig(
      [
        "profiles:",
        "  clob:",
        "    retries:",
        "      maxElapsedMs: 60000",
        "      attempts: 10",
      ].join("\n"),
    );
    const config = loadConfig(path);
    expect(config.profiles.clob?.retries?.maxElapsedMs).toBe(60_000);
    expect(config.profiles.clob?.retries?.attempts).toBe(10);
  });

  it("parses a valid user", () => {
    const path = writeConfig(
      [
        "users:",
        "  - id: main",
        "    token: supersecrettoken",
        `    privateKey: "0x${"a".repeat(64)}"`,
        `    funder: "0x${"b".repeat(40)}"`,
        "    signatureType: 3",
        "    creds:",
        "      apiKey: k",
        "      secret: s",
        "      passphrase: p",
      ].join("\n"),
    );
    const config = loadConfig(path);
    expect(config.users).toHaveLength(1);
    expect(config.users[0].id).toBe("main");
    expect(config.users[0].signatureType).toBe(3);
  });

  it("rejects duplicate tokens", () => {
    const userBlock = (id: string) =>
      [
        `  - id: ${id}`,
        "    token: dupetoken123",
        `    privateKey: "0x${"a".repeat(64)}"`,
        `    funder: "0x${"b".repeat(40)}"`,
        "    creds: { apiKey: k, secret: s, passphrase: p }",
      ].join("\n");
    const path = writeConfig(["users:", userBlock("a"), userBlock("b")].join("\n"));
    expect(() => loadConfig(path)).toThrow(/Duplicate gateway token/);
  });

  it("rejects invalid funder address", () => {
    const path = writeConfig(
      [
        "users:",
        "  - id: main",
        "    token: supersecrettoken",
        `    privateKey: "0x${"a".repeat(64)}"`,
        '    funder: "not-an-address"',
        "    creds: { apiKey: k, secret: s, passphrase: p }",
      ].join("\n"),
    );
    expect(() => loadConfig(path)).toThrow(/Invalid config/);
  });
});
