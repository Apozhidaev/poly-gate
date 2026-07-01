import { type Chain as ClobChain, ClobClient, SignatureTypeV2 } from "@polymarket/clob-client-v2";
import { type Chain as ViemChain, createWalletClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon, polygonAmoy } from "viem/chains";
import type { AppConfig, UserConfig } from "../../config/schema.js";

/**
 * Resolves a viem Chain for the configured chainId. Only used so viem's http()
 * transport has a default RPC URL; no RPC calls are made for EIP-712 signing.
 */
function viemChain(chainId: number): ViemChain {
  if (chainId === polygon.id) return polygon;
  if (chainId === polygonAmoy.id) return polygonAmoy;
  return defineChain({
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: ["http://localhost:8545"] } },
  });
}

export interface ResolvedUser {
  config: UserConfig;
  client: ClobClient;
}

/**
 * Builds and caches one authenticated ClobClient per configured wallet.
 * The service still works with zero users — private routes simply won't resolve one.
 */
export class ClobClientFactory {
  private readonly byId = new Map<string, ResolvedUser>();
  private readonly byToken = new Map<string, ResolvedUser>();

  constructor(config: AppConfig) {
    const chain = viemChain(config.upstreams.chainId);
    for (const user of config.users) {
      const account = privateKeyToAccount(user.privateKey as `0x${string}`);
      const signer = createWalletClient({ account, chain, transport: http() });

      const client = new ClobClient({
        host: config.upstreams.clob,
        chain: config.upstreams.chainId as ClobChain,
        signer,
        creds: {
          key: user.creds.apiKey,
          secret: user.creds.secret,
          passphrase: user.creds.passphrase,
        },
        signatureType: user.signatureType as SignatureTypeV2,
        funderAddress: user.funder,
      });

      const resolved: ResolvedUser = { config: user, client };
      this.byId.set(user.id, resolved);
      this.byToken.set(user.token, resolved);
    }
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
