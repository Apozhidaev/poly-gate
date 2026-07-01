import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { type AppConfig, configSchema } from "./schema.js";

export const CONFIG_ENV_VAR = "POLY_GATE_CONFIG";
const DEFAULT_CONFIG_PATH = "config.yaml";

export function loadConfig(explicitPath?: string): AppConfig {
  const path = resolve(explicitPath ?? process.env[CONFIG_ENV_VAR] ?? DEFAULT_CONFIG_PATH);

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Cannot read config file at "${path}". Set ${CONFIG_ENV_VAR} or create config.yaml. Cause: ${reason}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Config file "${path}" is not valid YAML: ${reason}`);
  }

  const result = configSchema.safeParse(parsed ?? {});
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid config file "${path}":\n${issues}`);
  }

  assertUniqueUsers(result.data);
  return result.data;
}

function assertUniqueUsers(config: AppConfig): void {
  const ids = new Set<string>();
  const tokens = new Set<string>();
  for (const user of config.users) {
    if (ids.has(user.id)) {
      throw new Error(`Duplicate user id "${user.id}" in config`);
    }
    if (tokens.has(user.token)) {
      throw new Error(`Duplicate gateway token detected in config (user "${user.id}")`);
    }
    ids.add(user.id);
    tokens.add(user.token);
  }
}

/** Redacts secrets so a config can be safely logged. */
export function redactConfig(config: AppConfig): unknown {
  return {
    ...config,
    users: config.users.map((u) => ({
      id: u.id,
      funder: u.funder,
      signatureType: u.signatureType,
      token: "***",
      privateKey: "***",
      creds: { apiKey: "***", secret: "***", passphrase: "***" },
    })),
  };
}
