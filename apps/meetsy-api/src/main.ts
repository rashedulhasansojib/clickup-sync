import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { Logger as PinoLogger } from "nestjs-pino";
import cookieParser from "cookie-parser";
import { AppModule } from "./app.module";
import { ConfigService } from "./config/config.service";

/**
 * API bootstrap.
 *  - Global CORS from CORS_ORIGINS (comma-split) so the web app's EventSource
 *    (SSE) and fetch calls are allowed.
 *  - Listens on API_PORT (default 4000).
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  // Structured JSON logging (pino) as the app-wide logger.
  app.useLogger(app.get(PinoLogger));
  const config = app.get(ConfigService);

  // Parse cookies so AuthGuard can read the shared `clickup_sync_sid` session
  // cookie (and the `csrf` double-submit cookie).
  app.use(cookieParser());

  // CORS with credentials so the browser sends the cross-subdomain session
  // cookie (and EventSource SSE) from the allowed Clicksy/Meetsy origins.
  app.enableCors({
    origin: config.get("corsOrigins"),
    credentials: true,
  });

  const port = config.get("API_PORT");
  await app.listen(port);
  new Logger("Bootstrap").log(`API listening on http://localhost:${port}`);
}

void bootstrap();
