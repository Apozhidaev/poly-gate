import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";

const DEFAULT_ENV_PATH = ".env";

/** Loads `.env` from cwd when present. Existing process.env values take precedence. */
export function loadDotEnv(path = DEFAULT_ENV_PATH): void {
  const resolved = resolve(path.trim());
  if (!existsSync(resolved)) return;
  loadEnvFile(resolved);
}
