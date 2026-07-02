import type { AppConfig } from "./config/schema.js";
import { HttpProxy } from "./lib/httpProxy.js";
import { ClobClientFactory, type ResolvedUser } from "./lib/polymarket/clientFactory.js";
import { RateLimiterRegistry } from "./lib/rateLimiter.js";

/** Shared services available to every route via `app.gate`. */
export interface GateContext {
  config: AppConfig;
  limiter: RateLimiterRegistry;
  httpProxy: HttpProxy;
  clients: ClobClientFactory;
}

export function buildContext(
  config: AppConfig,
  logger: { warn: (obj: unknown, msg?: string) => void },
): GateContext {
  const limiter = new RateLimiterRegistry(config.rateLimits.enabled);
  const httpProxy = new HttpProxy(limiter, config.retries, logger, config.http.timeoutMs);
  const clients = new ClobClientFactory(config);
  return { config, limiter, httpProxy, clients };
}

declare module "fastify" {
  interface FastifyInstance {
    gate: GateContext;
  }
  interface FastifyRequest {
    /** Set by the auth plugin on private CLOB routes. */
    polyUser?: ResolvedUser;
  }
}
