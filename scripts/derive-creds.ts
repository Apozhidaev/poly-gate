/**
 * Derives (or creates) L2 API credentials for a private key using L1 auth.
 *
 * Usage:
 *   PRIVATE_KEY=0x... npm run derive-creds
 *   PRIVATE_KEY=0x... CLOB_HOST=https://clob.polymarket.com CHAIN_ID=137 NONCE=0 npm run derive-creds
 */
import { type Chain, ClobClient } from "@polymarket/clob-client-v2";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon, polygonAmoy } from "viem/chains";

async function main(): Promise<void> {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    throw new Error("Set PRIVATE_KEY env var (0x-prefixed private key)");
  }
  const host = process.env.CLOB_HOST ?? "https://clob.polymarket.com";
  const chainId = Number(process.env.CHAIN_ID ?? "137");
  const nonce = process.env.NONCE ? Number(process.env.NONCE) : undefined;

  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const chain = chainId === polygonAmoy.id ? polygonAmoy : polygon;
  const signer = createWalletClient({ account, chain, transport: http() });
  const client = new ClobClient({ host, chain: chainId as Chain, signer });

  const creds = await client.createOrDeriveApiKey(nonce);

  console.log("Signer address:", account.address);
  console.log("\nAdd this to your config user entry:\n");
  console.log("    creds:");
  console.log(`      apiKey: "${creds.key}"`);
  console.log(`      secret: "${creds.secret}"`);
  console.log(`      passphrase: "${creds.passphrase}"`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
