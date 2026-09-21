import { createSecureClient, type SecureClient } from "@polymarket/client";
import { privateKey } from "@polymarket/client/viem";
import type { AppConfig, UserConfig } from "../../config/schema.js";

export interface ResolvedUser {
  config: UserConfig;
  client: SecureClient;
}

/**
 * Builds and caches one authenticated SecureClient per configured wallet.
 * The service still works with zero users — private routes simply won't resolve one.
 */
export class ClobClientFactory {
  private readonly byId = new Map<string, ResolvedUser>();
  private readonly byToken = new Map<string, ResolvedUser>();

  private constructor() {}

  static async create(config: AppConfig): Promise<ClobClientFactory> {
    const factory = new ClobClientFactory();
    for (const user of config.users) {
      const client = await createSecureClient({
        wallet: user.funder,
        signer: privateKey(user.privateKey as `0x${string}`),
      });

      const resolved: ResolvedUser = { config: user, client };
      factory.byId.set(user.id, resolved);
      factory.byToken.set(user.token, resolved);
    }
    return factory;
  }

  get hasUsers(): boolean {
    return this.byToken.size > 0;
  }

  getByToken(token: string): ResolvedUser | undefined {
    return this.byToken.get(token);
  }

  getById(id: string): ResolvedUser | undefined {
    return this.byId.get(id);
  }
}
