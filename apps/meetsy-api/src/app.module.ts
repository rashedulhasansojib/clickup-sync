import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { LoggerModule } from "nestjs-pino";
import { ConfigModule } from "./config/config.module";
import { PrismaModule } from "./prisma/prisma.module";
import { AzureModule } from "./azure/azure.module";
import { AnalysisModule } from "./analysis/analysis.module";
import { ClickUpModule } from "./clickup/clickup.module";
import { KbModule } from "./kb/kb.module";
import { TuningModule } from "./tuning/tuning.module";
import { AuthModule } from "./auth/auth.module";
import { AuthGuard } from "./auth/auth.guard";
import { RolesGuard } from "./auth/roles.guard";
import { HealthController } from "./health/health.controller";

@Module({
  imports: [
    // Structured JSON request/app logging. Redacts the Authorization header.
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? "info",
        redact: ["req.headers.authorization"],
      },
    }),
    ConfigModule,
    PrismaModule,
    AzureModule,
    AuthModule,
    AnalysisModule,
    ClickUpModule,
    KbModule,
    TuningModule,
  ],
  controllers: [HealthController],
  providers: [
    // Global: authenticate every route (except @Public) via the shared cookie
    // session, then enforce @Roles.
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
