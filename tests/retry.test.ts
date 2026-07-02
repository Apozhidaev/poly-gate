import { describe, expect, it, vi } from "vitest";
import { UpstreamError } from "../src/lib/errors.js";
import { withRetry } from "../src/lib/retry.js";

const cfg = { enabled: true, attempts: 3, baseDelayMs: 1, maxDelayMs: 5, factor: 2, maxElapsedMs: 0 };

describe("withRetry", () => {
  it("retries retryable UpstreamError then succeeds", async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls < 3) throw new UpstreamError("boom", { status: 503 });
      return "ok";
    });
    const result = await withRetry(fn, { cfg });
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("does not retry non-retryable 4xx", async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      throw new UpstreamError("bad", { status: 400 });
    });
    await expect(withRetry(fn, { cfg })).rejects.toThrow("bad");
    expect(calls).toBe(1);
  });

  it("never retries when disabled", async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      throw new UpstreamError("boom", { status: 503 });
    });
    await expect(withRetry(fn, { cfg, disabled: true })).rejects.toThrow("boom");
    expect(calls).toBe(1);
  });

  it("gives up after max attempts", async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      throw new UpstreamError("boom", { status: 500 });
    });
    await expect(withRetry(fn, { cfg })).rejects.toThrow("boom");
    expect(calls).toBe(cfg.attempts + 1);
  });

  it("stops retrying once the time budget is exhausted", async () => {
    // High attempts cap, but a tiny elapsed budget should stop us far sooner.
    const budgetCfg = {
      enabled: true,
      attempts: 1000,
      baseDelayMs: 10,
      maxDelayMs: 10,
      factor: 1,
      maxElapsedMs: 50,
    };
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      throw new UpstreamError("boom", { status: 503 });
    });
    await expect(withRetry(fn, { cfg: budgetCfg })).rejects.toThrow("boom");
    expect(calls).toBeGreaterThan(0);
    expect(calls).toBeLessThan(budgetCfg.attempts);
  });
});
