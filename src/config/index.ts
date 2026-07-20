import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  type AppConfig,
  type UserConfig,
  configSchema,
  usersSchema,
} from "./schema.js";

export const CONFIG_ENV_VAR = "POLY_GATE_CONFIG";
export const USERS_ENV_VAR = "POLY_GATE_USERS";
const DEFAULT_CONFIG_PATH = "config.yaml";

function formatZodIssues(issues: { path: (string | number)[]; message: string }[]): string {
  return issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
}

function readYamlFile(path: string, label: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot read ${label} at "${path}". Cause: ${reason}`);
  }

  try {
    return parseYaml(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`${label} "${path}" is not valid YAML: ${reason}`);
  }
}

function loadUsersFile(path: string): UserConfig[] {
  const parsed = readYamlFile(path, "users file");
  const result = usersSchema.safeParse(parsed ?? []);
  if (!result.success) {
    throw new Error(`Invalid users file "${path}":\n${formatZodIssues(result.error.issues)}`);
  }
  return result.data;
}

export function loadConfig(explicitPath?: string, explicitUsersPath?: string): AppConfig {
  const path = resolve((explicitPath ?? process.env[CONFIG_ENV_VAR] ?? DEFAULT_CONFIG_PATH).trim());
  const parsed = readYamlFile(path, "config file");
  const result = configSchema.safeParse(parsed ?? {});
  if (!result.success) {
    throw new Error(`Invalid config file "${path}":\n${formatZodIssues(result.error.issues)}`);
  }

  const usersPath = explicitUsersPath ?? process.env[USERS_ENV_VAR];
  const users = usersPath ? loadUsersFile(resolve(usersPath.trim())) : [];
  const config: AppConfig = { ...result.data, users };

  assertUniqueUsers(config);
  return config;
}

function assertUniqueUsers(config: AppConfig): void {
  const ids = new Set<string>();
  const tokens = new Set<string>();
  for (const user of config.users) {
    if (ids.has(user.id)) {
      throw new Error(`Duplicate user id "${user.id}" in users file`);
    }
    if (tokens.has(user.token)) {
      throw new Error(`Duplicate gateway token detected in users file (user "${user.id}")`);
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
