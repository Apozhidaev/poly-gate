import type { Api } from "../config/api.js";
import type {
  AppConfig,
  ProfileConfig,
  ProfileOverrides,
} from "../config/schema.js";

/** Resolves the effective retry config for an upstream API. */
export class ProfileResolver {
  constructor(private readonly config: AppConfig) {}

  resolve(api: Api, overrides?: ProfileOverrides): ProfileConfig {
    const base = this.config.retries;
    const profileOverrides = this.config.profiles[api]?.retries;
    const customOverrides = overrides?.retries;

    return {
      retries: {
        ...base,
        maxElapsedMs:
          customOverrides?.maxElapsedMs ??
          profileOverrides?.maxElapsedMs ??
          base.maxElapsedMs,
        attempts:
          customOverrides?.attempts ??
          profileOverrides?.attempts ??
          base.attempts,
      },
    };
  }
}
