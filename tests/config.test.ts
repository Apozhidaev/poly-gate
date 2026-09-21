import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, USERS_ENV_VAR } from "../src/config/index.js";

function writeConfigFiles(configContent: string, usersContent?: string): {
  configPath: string;
  usersPath?: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "poly-gate-"));
  const configPath = join(dir, "config.yaml");
  writeFileSync(configPath, configContent, "utf8");
  if (usersContent !== undefined) {
    const usersPath = join(dir, "users.yaml");
    writeFileSync(usersPath, usersContent, "utf8");
    return { configPath, usersPath };
  }
  return { configPath };
}

const userBlock = (id: string, token = "supersecrettoken") =>
  [
    `- id: ${id}`,
    `  token: ${token}`,
    `  privateKey: "0x${"a".repeat(64)}"`,
    `  funder: "0x${"b".repeat(40)}"`,
  ].join("\n");

describe("loadConfig", () => {
  const originalUsersEnv = process.env[USERS_ENV_VAR];

  afterEach(() => {
    if (originalUsersEnv === undefined) {
      delete process.env[USERS_ENV_VAR];
    } else {
      process.env[USERS_ENV_VAR] = originalUsersEnv;
    }
  });

  it("loads with defaults and no users when users path is unset", () => {
    delete process.env[USERS_ENV_VAR];
    const { configPath } = writeConfigFiles("server:\n  port: 9090\n");
    const config = loadConfig(configPath);
    expect(config.server.port).toBe(9090);
    expect(config.users).toEqual([]);
    expect(config.upstreams.gamma).toContain("gamma-api.polymarket.com");
    expect(config.retries.attempts).toBe(30);
    expect(config.retries.maxElapsedMs).toBe(1_800_000);
  });

  it("parses per-API retry profiles", () => {
    const { configPath } = writeConfigFiles(
      [
        "profiles:",
        "  clob:",
        "    retries:",
        "      maxElapsedMs: 60000",
        "      attempts: 10",
      ].join("\n"),
    );
    const config = loadConfig(configPath);
    expect(config.profiles.clob?.retries?.maxElapsedMs).toBe(60_000);
    expect(config.profiles.clob?.retries?.attempts).toBe(10);
  });

  it("loads users from a separate file", () => {
    const { configPath, usersPath } = writeConfigFiles(
      "server:\n  port: 8080\n",
      userBlock("main"),
    );
    const config = loadConfig(configPath, usersPath);
    expect(config.users).toHaveLength(1);
    expect(config.users[0].id).toBe("main");
    expect(config.users[0].funder).toMatch(/^0xb+$/);
  });

  it("accepts multiple users in users.yaml", () => {
    const { configPath, usersPath } = writeConfigFiles("", [userBlock("a"), userBlock("b", "othertoken123")].join("\n"));
    const config = loadConfig(configPath, usersPath);
    expect(config.users).toHaveLength(2);
  });

  it("rejects duplicate tokens in users file", () => {
    const { configPath, usersPath } = writeConfigFiles("", [
      userBlock("a", "dupetoken123"),
      userBlock("b", "dupetoken123"),
    ].join("\n"));
    expect(() => loadConfig(configPath, usersPath)).toThrow(/Duplicate gateway token/);
  });

  it("rejects invalid funder address in users file", () => {
    const { configPath, usersPath } = writeConfigFiles(
      "",
      [
        "- id: main",
        "  token: supersecrettoken",
        `  privateKey: "0x${"a".repeat(64)}"`,
        '  funder: "not-an-address"',
      ].join("\n"),
    );
    expect(() => loadConfig(configPath, usersPath)).toThrow(/Invalid users file/);
  });

  it("throws when users file is missing", () => {
    const { configPath } = writeConfigFiles("server:\n  port: 8080\n");
    expect(() => loadConfig(configPath, "/no/such/users.yaml")).toThrow(/Cannot read users file/);
  });

  it("loads empty users from an empty users file", () => {
    const { configPath, usersPath } = writeConfigFiles("", "[]\n");
    const config = loadConfig(configPath, usersPath);
    expect(config.users).toEqual([]);
  });
});
