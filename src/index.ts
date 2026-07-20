import { loadDotEnv } from "./loadEnv.js";
import { loadConfig, redactConfig } from "./config/index.js";
import { buildServer } from "./server.js";

loadDotEnv();

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await buildServer(config);

  app.log.info({ config: redactConfig(config) }, "loaded configuration");

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "shutting down");
    try {
      await app.close();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, "error during shutdown");
      process.exit(1);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ host: config.server.host, port: config.server.port });
  app.log.info(`Swagger UI available at http://${config.server.host}:${config.server.port}/docs`);
}

main().catch((err) => {
  // Config/boot errors: print clearly and exit non-zero.
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
