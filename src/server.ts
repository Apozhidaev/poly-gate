import { type TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import Fastify, { type FastifyInstance } from "fastify";
import type { AppConfig } from "./config/schema.js";
import { buildContext } from "./context.js";
import { registerAuth } from "./plugins/auth.js";
import { registerErrorHandler } from "./plugins/errorHandler.js";
import { registerSwagger } from "./plugins/swagger.js";
import { registerClobPrivateRoutes } from "./routes/clobPrivate.js";
import { registerClobPublicRoutes } from "./routes/clobPublic.js";
import { registerDataRoutes } from "./routes/data.js";
import { registerGammaRoutes } from "./routes/gamma.js";
import { registerSystemRoutes } from "./routes/system.js";

export async function buildServer(config: AppConfig): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.logLevel },
    // find-my-way / Fastify impose defaults; use max safe integer so upstream rejects
    // oversized payloads, not the gateway (private service, no public abuse surface).
    bodyLimit: Number.MAX_SAFE_INTEGER,
    // find-my-way defaults to 100; no "unlimited" option — use max safe integer so the
    // gateway never rejects long path params (slugs, ids) before forwarding upstream.
    routerOptions: { maxParamLength: Number.MAX_SAFE_INTEGER },
  }).withTypeProvider<TypeBoxTypeProvider>();

  // Shared services.
  app.decorate("gate", await buildContext(config, app.log));

  registerErrorHandler(app);
  registerAuth(app);
  await registerSwagger(app);

  // Routes.
  registerSystemRoutes(app);
  registerGammaRoutes(app);
  registerDataRoutes(app);
  registerClobPublicRoutes(app);
  registerClobPrivateRoutes(app);

  app.addHook("onClose", async () => {
    console.log("Disconnecting...");
  });

  return app;
}
