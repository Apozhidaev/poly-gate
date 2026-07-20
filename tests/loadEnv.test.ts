import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadDotEnv } from "../src/loadEnv.js";

describe("loadDotEnv", () => {
  const key = "POLY_GATE_LOAD_ENV_TEST";
  const original = process.env[key];

  afterEach(() => {
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  });

  it("loads variables from an existing .env file", () => {
    delete process.env[key];
    const dir = mkdtempSync(join(tmpdir(), "poly-gate-env-"));
    const envPath = join(dir, ".env");
    writeFileSync(envPath, `${key}=from-file\n`, "utf8");

    loadDotEnv(envPath);

    expect(process.env[key]).toBe("from-file");
  });

  it("does not throw when .env is missing", () => {
    expect(() => loadDotEnv(join(tmpdir(), "no-such-env-file"))).not.toThrow();
  });

  it("does not override an existing process.env value", () => {
    const dir = mkdtempSync(join(tmpdir(), "poly-gate-env-"));
    const envPath = join(dir, ".env");
    writeFileSync(envPath, `${key}=from-file\n`, "utf8");
    process.env[key] = "from-shell";

    loadDotEnv(envPath);

    expect(process.env[key]).toBe("from-shell");
  });
});
