import type { Api } from "../config/api.js";
import type { AppConfig, ProfileConfig } from "../config/schema.js";

/** Resolves the effective retry config for an upstream API. */
export class ProfileResolver {
  constructor(private readonly config: AppConfig) {}

  resolve(api: Api): ProfileConfig {
    const base = this.config.retries;
    const override = this.config.profiles[api]?.retries;

    return {
      retries: {
        ...base,
        maxElapsedMs: override?.maxElapsedMs ?? base.maxElapsedMs,
        attempts: override?.attempts ?? base.attempts,
      },
    };
  }
}
