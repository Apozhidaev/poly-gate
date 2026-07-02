import { z } from "zod";

const hexString = z.string().regex(/^0x[0-9a-fA-F]+$/, "must be a 0x-prefixed hex string");
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x-prefixed 40-hex address");

export const credsSchema = z.object({
  apiKey: z.string().min(1),
  secret: z.string().min(1),
  passphrase: z.string().min(1),
});

export const userSchema = z.object({
  id: z.string().min(1),
  token: z.string().min(8, "gateway token must be at least 8 chars"),
  privateKey: hexString,
  funder: address,
  // Polymarket signature type: 1=POLY_PROXY, 2=POLY_GNOSIS_SAFE, 3=POLY_1271.
  // All three sign with the EOA (privateKey) on behalf of the `funder` wallet.
  signatureType: z
    .union([z.literal(1), z.literal(2), z.literal(3)])
    .default(3),
  creds: credsSchema,
});

export const configSchema = z.object({
  server: z
    .object({
      host: z.string().default("0.0.0.0"),
      port: z.number().int().positive().default(8080),
    })
    .default({ host: "0.0.0.0", port: 8080 }),
  upstreams: z
    .object({
      gamma: z.string().url().default("https://gamma-api.polymarket.com"),
      data: z.string().url().default("https://data-api.polymarket.com"),
      clob: z.string().url().default("https://clob.polymarket.com"),
      pnl: z.string().url().default("https://user-pnl-api.polymarket.com"),
      chainId: z.number().int().default(137),
    })
    .default({
      gamma: "https://gamma-api.polymarket.com",
      data: "https://data-api.polymarket.com",
      clob: "https://clob.polymarket.com",
      pnl: "https://user-pnl-api.polymarket.com",
      chainId: 137,
    }),
  // Optional: the service must boot and serve public endpoints even without any users.
  users: z.array(userSchema).default([]),
  rateLimits: z
    .object({
      enabled: z.boolean().default(true),
    })
    .default({ enabled: true }),
  retries: z
    .object({
      enabled: z.boolean().default(true),
      // Safety cap on the number of retries; the real limiter is maxElapsedMs.
      attempts: z.number().int().min(0).default(30),
      baseDelayMs: z.number().int().min(0).default(250),
      maxDelayMs: z.number().int().min(0).default(30000),
      factor: z.number().min(1).default(2),
      // Overall time budget across all retries (ms); 0 disables (use attempts only).
      // Encodes "keep trying for up to N minutes"; a retry is skipped once the
      // elapsed time plus the next backoff delay would exceed this budget.
      maxElapsedMs: z.number().int().min(0).default(1_800_000),
    })
    .default({
      enabled: true,
      attempts: 30,
      baseDelayMs: 250,
      maxDelayMs: 30000,
      factor: 2,
      maxElapsedMs: 1_800_000,
    }),
  // Outbound HTTP settings for requests the gateway makes to Polymarket.
  http: z
    .object({
      // Per-attempt timeout for outbound fetch calls (ms). 0 disables it.
      // A hung upstream connection never returns data, so timing out lets the
      // request become retryable instead of hanging on a dead socket.
      // Keep it above the slowest legitimate query: some historical Polymarket
      // endpoints can take ~1 minute, so the default leaves headroom.
      timeoutMs: z.number().int().min(0).default(120000),
    })
    .default({ timeoutMs: 120000 }),
  logLevel: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
});

export type AppConfig = z.infer<typeof configSchema>;
export type UserConfig = z.infer<typeof userSchema>;
export type RetryConfig = AppConfig["retries"];
