import type { AppConfig } from "./config/schema.js";
import { HttpProxy } from "./lib/httpProxy.js";
import { ClobClientFactory, type ResolvedUser } from "./lib/polymarket/clientFactory.js";
import { RateLimiterRegistry } from "./lib/rateLimiterRegistry.js";
import { ProfileResolver } from "./lib/profileResolver.js";

/** Shared services available to every route via `app.gate`. */
export interface GateContext {
  config: AppConfig;
  limiter: RateLimiterRegistry;
  profile: ProfileResolver;
  httpProxy: HttpProxy;
  clients: ClobClientFactory;
}

export async function buildContext(
  config: AppConfig,
  logger: { warn: (obj: unknown, msg?: string) => void },
): Promise<GateContext> {
  const limiter = new RateLimiterRegistry(config.rateLimits.enabled);
  const profile = new ProfileResolver(config);
  const httpProxy = new HttpProxy(limiter, profile, logger, config.http.timeoutMs);
  const clients = await ClobClientFactory.create(config);
  return { config, limiter, profile, httpProxy, clients };
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
