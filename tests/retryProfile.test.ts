import { describe, expect, it } from "vitest";
import { configSchema, type AppConfig } from "../src/config/schema.js";
import { ProfileResolver } from "../src/lib/profileResolver.js";

function baseConfig(overrides: Record<string, unknown> = {}): AppConfig {
  return { ...configSchema.parse(overrides), users: [] };
}

describe("ProfileResolver", () => {
  it("uses global retries when no profile is set", () => {
    const resolver = new ProfileResolver(baseConfig());

    for (const api of ["data", "clob", "gamma"] as const) {
      const cfg = resolver.resolve(api).retries;
      expect(cfg.maxElapsedMs).toBe(1_800_000);
      expect(cfg.attempts).toBe(30);
    }
  });

  it("inherits global backoff settings", () => {
    const resolver = new ProfileResolver(
      baseConfig({ retries: { baseDelayMs: 500, factor: 3, maxDelayMs: 5000 } }),
    );
    const cfg = resolver.resolve("clob").retries;

    expect(cfg.baseDelayMs).toBe(500);
    expect(cfg.factor).toBe(3);
    expect(cfg.maxDelayMs).toBe(5000);
    expect(cfg.enabled).toBe(true);
  });

  it("yaml profile overrides global defaults", () => {
    const resolver = new ProfileResolver(
      baseConfig({
        profiles: {
          clob: { retries: { maxElapsedMs: 60_000, attempts: 5 } },
        },
      }),
    );
    const cfg = resolver.resolve("clob").retries;

    expect(cfg.maxElapsedMs).toBe(60_000);
    expect(cfg.attempts).toBe(5);
  });

  it("partial yaml override keeps other global fields", () => {
    const resolver = new ProfileResolver(
      baseConfig({
        profiles: {
          data: { retries: { maxElapsedMs: 3_600_000 } },
        },
      }),
    );
    const cfg = resolver.resolve("data").retries;

    expect(cfg.maxElapsedMs).toBe(3_600_000);
    expect(cfg.attempts).toBe(30);
  });
});
