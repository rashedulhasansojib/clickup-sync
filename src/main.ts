import 'dotenv/config';
import 'reflect-metadata';

// BigInt is not JSON-serializable by default; convert to string so Express can respond.
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function () {
  return this.toString();
};
import compression from 'compression';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { getRole } from './config/role';
import { helmetOptions } from './config/helmet.config';

async function bootstrap() {
  // Worker role: boot the DI container so BullMQ processors + cron start, but
  // do NOT open an HTTP port. enableShutdownHooks() lets SIGTERM drain active
  // jobs cleanly on deploy. No helmet/cors/swagger/listen — there is no HTTP.
  if (getRole() === 'worker') {
    const app = await NestFactory.create(AppModule, { bufferLogs: true });
    app.enableShutdownHooks();
    await app.init();
    return;
  }
  const app = await NestFactory.create(AppModule, { bufferLogs: true, rawBody: true });
  // Drain in-flight work on SIGTERM/SIGINT: triggers Nest lifecycle hooks so
  // BullMQ workers close (finishing active jobs) and the Prisma/Redis pools
  // disconnect cleanly instead of being hard-killed mid-job on every deploy.
  app.enableShutdownHooks();
  // Behind the prod reverse proxy, trust the first hop so `req.ip` is the real
  // client address (not the proxy's). Without this the per-IP login throttler
  // keys every request to the proxy IP and collapses into one shared bucket —
  // brute-force protection gone, and one client can lock everyone out. Match the
  // hop count to the actual deployment topology if more than one proxy is added.
  app.getHttpAdapter().getInstance().set('trust proxy', 1);
  app.use(helmet(helmetOptions));
  app.use(compression());
  app.use(cookieParser());
  app.enableCors({
    origin: (process.env.ALLOWED_ORIGINS ?? 'http://localhost:5173').split(',').map((s) => s.trim()),
    credentials: true,
  });
  app.setGlobalPrefix('api');
  // whitelist:true already strips unknown props (kills mass-assignment); we do
  // NOT set forbidNonWhitelisted because turning unknown fields into hard 400s
  // is a behavior change across every write endpoint the SPA hits and isn't
  // needed for the security property.
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  // Swagger exposes the full API surface (every admin/reports route + the
  // x-admin-key scheme) unauthenticated. Keep it off in production unless an
  // operator explicitly opts in via ENABLE_SWAGGER=true.
  const swaggerEnabled =
    process.env.ENABLE_SWAGGER === 'true' || process.env.NODE_ENV !== 'production';
  if (swaggerEnabled) {
    const config = new DocumentBuilder()
      .setTitle('ClickUp Sync API')
      .setDescription('NestJS service for ClickUp webhook ingestion, backfills, time entries, and cost sync.')
      .setVersion('0.1.0')
      .addApiKey({ type: 'apiKey', name: 'x-admin-key', in: 'header' }, 'x-admin-key')
      .build();
    SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config));
  }

  const port = Number(process.env.PORT || 3000);
  await app.listen(port);
}
bootstrap();
