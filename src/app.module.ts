import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { BullModule } from '@nestjs/bullmq';
import { ServeStaticModule } from '@nestjs/serve-static';
import { ThrottlerModule } from '@nestjs/throttler';
import { join } from 'path';
import { validateEnv } from './config/env.validation';
import { buildBullConnection } from './config/connection.config';
import { DatabaseModule } from './database/database.module';
import { SettingsModule } from './settings/settings.module';
import { WorkspaceModule } from './workspaces/workspace.module';
import { ClickupModule } from './clickup/clickup.module';
import { QueuesModule } from './queues/queues.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { TasksModule } from './tasks/tasks.module';
import { TimeEntriesModule } from './time-entries/time-entries.module';
import { RatesModule } from './rates/rates.module';
import { SyncModule } from './sync/sync.module';
import { WorkersModule } from './workers/workers.module';
import { AdminModule } from './admin/admin.module';
import { BudgetsModule } from './budgets/budgets.module';
import { ReportsModule } from './reports/reports.module';
import { AuthModule } from './auth/auth.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'apps', 'web', 'dist'),
      // path-to-regexp v8 (pulled in via Express 5 / serve-static 5) rejects the
      // old `(.*)` capture-group syntax — it threw on every request, 500-ing all
      // API routes. The v8 equivalent is a named wildcard. is-route-excluded
      // appends a trailing `/`, so `/<prefix>/*splat` matches both the bare
      // prefix and any sub-path.
      exclude: ['/api/*splat', '/docs/*splat', '/webhooks/*splat', '/admin/*splat', '/reports/*splat'],
    }),
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    ScheduleModule.forRoot(),
    BullModule.forRootAsync({
      useFactory: () => ({ connection: buildBullConnection(process.env.REDIS_URL ?? '') }),
    }),
    DatabaseModule,
    SettingsModule,
    WorkspaceModule,
    ClickupModule,
    QueuesModule,
    WebhooksModule,
    TasksModule,
    TimeEntriesModule,
    RatesModule,
    SyncModule,
    WorkersModule,
    AdminModule,
    BudgetsModule,
    ReportsModule,
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 5 }]),
    AuthModule,
    HealthModule,
  ],
})
export class AppModule {}
