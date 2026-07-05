import type { Api } from "../config/api.js";
import type {
  AppConfig,
  ProfileConfig,
  ProfileOverrides,
  RetryConfig,
} from "../config/schema.js";

/** Resolves the effective retry config for an upstream API. */
export class ProfileResolver {
  constructor(private readonly config: AppConfig) {}

  _resolveRetries(api: Api, overrides?: ProfileOverrides): RetryConfig {
    const base = this.config.retries;
    const profileOverrides = this.config.profiles[api]?.retries;
    const customOverrides = overrides?.retries;

    return {
      ...base,
      maxElapsedMs:
        customOverrides?.maxElapsedMs ??
        profileOverrides?.maxElapsedMs ??
        base.maxElapsedMs,
      attempts:
        customOverrides?.attempts ??
        profileOverrides?.attempts ??
        base.attempts,
    };
  }

  resolve(api: Api, overrides?: ProfileOverrides): ProfileConfig {
    return { retries: this._resolveRetries(api, overrides) };
  }
}
