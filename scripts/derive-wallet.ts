/**
 * Derives an EVM address and private key from a BIP39 seed phrase.
 *
 * Usage:
 *   MNEMONIC="word1 word2 ... word12" npm run derive-wallet
 *   MNEMONIC="..." ACCOUNT_INDEX=0 ADDRESS_INDEX=1 npm run derive-wallet
 *   MNEMONIC="..." PASSPHRASE="optional bip39 passphrase" npm run derive-wallet
 *
 * Default path: m/44'/60'/{accountIndex}'/0/{addressIndex} (MetaMask-style).
 * Do not log or commit MNEMONIC, PASSPHRASE, or the printed private key.
 */
import { toHex } from "viem";
import { mnemonicToAccount } from "viem/accounts";

async function main(): Promise<void> {
  const mnemonic = process.env.MNEMONIC?.trim();
  if (!mnemonic) {
    throw new Error("Set MNEMONIC env var (BIP39 seed phrase)");
  }

  const accountIndex = Number(process.env.ACCOUNT_INDEX ?? "0");
  const addressIndex = Number(process.env.ADDRESS_INDEX ?? "0");
  const passphrase = process.env.PASSPHRASE;

  const account = mnemonicToAccount(mnemonic, {
    accountIndex,
    addressIndex,
    ...(passphrase ? { passphrase } : {}),
  });

  const privateKey = toHex(account.getHdKey().privateKey!);

  console.log("Address:", account.address);
  console.log("Private key:", privateKey);
  console.log("\nUse privateKey in config.yaml and POST /clob/derive-api-key if you need L2 creds.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
