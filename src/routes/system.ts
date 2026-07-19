import { wordlist as englishWordlist } from "@scure/bip39/wordlists/english";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { toHex } from "viem";
import { generateMnemonic, mnemonicToAccount } from "viem/accounts";

const generateSeedBody = Type.Object({
  strength: Type.Optional(
    Type.Union([Type.Literal(128), Type.Literal(256)], {
      default: 128,
      description: "Mnemonic entropy: 128 = 12 words, 256 = 24 words",
    }),
  ),
});

const deriveWalletBody = Type.Object({
  mnemonic: Type.String({ minLength: 1, description: "BIP39 seed phrase" }),
  accountIndex: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
  addressIndex: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
  passphrase: Type.Optional(Type.String()),
});

export function registerSystemRoutes(app: FastifyInstance): void {
  app.get(
    "/system/health",
    {
      schema: {
        tags: ["system"],
        summary: "Gateway health check",
        response: {
          200: Type.Object({
            status: Type.Literal("ok"),
            users: Type.Number({ description: "Number of configured wallets" }),
            uptimeSeconds: Type.Number(),
          }),
        },
      },
    },
    async () => ({
      status: "ok" as const,
      users: app.gate.clients.hasUsers ? app.gate.config.users.length : 0,
      uptimeSeconds: Math.round(process.uptime()),
    }),
  );

  app.post(
    "/system/generate-seed",
    {
      schema: {
        tags: ["system"],
        summary: "Generate BIP39 seed phrase",
        description: "Returns a randomly generated BIP39 mnemonic (English wordlist).",
        body: generateSeedBody,
        response: {
          200: Type.Object({
            mnemonic: Type.String(),
          }),
        },
      },
    },
    (request) => {
      const { strength = 128 } = (request.body ?? {}) as { strength?: 128 | 256 };
      return { mnemonic: generateMnemonic(englishWordlist, strength) };
    },
  );

  app.post(
    "/system/derive-wallet",
    {
      schema: {
        tags: ["system"],
        summary: "Derive EVM wallet from seed phrase",
        description:
          "Derives address and private key from a BIP39 mnemonic (MetaMask-style path m/44'/60'/accountIndex'/0/addressIndex).",
        body: deriveWalletBody,
        response: {
          200: Type.Object({
            address: Type.String(),
            privateKey: Type.String(),
          }),
        },
      },
    },
    (request) => {
      const {
        mnemonic,
        accountIndex = 0,
        addressIndex = 0,
        passphrase,
      } = request.body as {
        mnemonic: string;
        accountIndex?: number;
        addressIndex?: number;
        passphrase?: string;
      };

      const account = mnemonicToAccount(mnemonic.trim(), {
        accountIndex,
        addressIndex,
        ...(passphrase ? { passphrase } : {}),
      });
      return {
        address: account.address,
        privateKey: toHex(account.getHdKey().privateKey!),
      };
    },
  );

  app.get(
    "/system/user-creds",
    {
      preHandler: app.requireAuth,
      schema: {
        tags: ["system"],
        summary: "Get L2 API credentials",
        description:
          "Returns Polymarket L2 credentials (apiKey, secret, passphrase) for the wallet selected by the Bearer token.",
        security: [{ bearerAuth: [] }],
        response: {
          200: Type.Object({
            apiKey: Type.String(),
            secret: Type.String(),
            passphrase: Type.String(),
          }),
        },
      },
    },
    (request) => {
      const creds = request.polyUser!.config.creds;
      return {
        apiKey: creds.apiKey,
        secret: creds.secret,
        passphrase: creds.passphrase,
      };
    },
  );
}
