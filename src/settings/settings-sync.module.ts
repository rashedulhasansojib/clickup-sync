import { Module } from '@nestjs/common';
import { QueuesModule } from '../queues/queues.module';
import { SettingsSyncService } from './settings-sync.service';

/**
 * Deliberately separate from the @Global `SettingsModule`.
 *
 * `QueueService` injects `SettingsService`, so `SettingsModule` cannot import
 * `QueuesModule` without a provider cycle. Keeping the Redis-backed
 * invalidation in its own module gives the clean one-way graph
 * SettingsModule ← QueuesModule ← SettingsSyncModule.
 */
@Module({
  imports: [QueuesModule],
  providers: [SettingsSyncService],
  exports: [SettingsSyncService],
})
export class SettingsSyncModule {}
