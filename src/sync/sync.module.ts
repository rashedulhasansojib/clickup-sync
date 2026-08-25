import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { QueuesModule } from '../queues/queues.module';
import { ClickupModule } from '../clickup/clickup.module';
import { TasksModule } from '../tasks/tasks.module';
import { ListsModule } from '../lists/lists.module';
import { SyncCheckpointsRepository } from './sync-checkpoints.repository';
import { BackfillService } from './backfill.service';
import { SyncScheduler } from './sync.scheduler';
import { isWorker } from '../config/role';

const worker = isWorker();

// ListsModule is imported unconditionally (both roles): it only provides
// ListsRepository + ListCatalogService (no cron of its own). ScheduleModule and
// SyncScheduler stay worker-gated so the daily crons fire in the single worker
// container, never in the web colors.
@Module({
  imports: [...(worker ? [ScheduleModule] : []), QueuesModule, ClickupModule, TasksModule, ListsModule],
  providers: [SyncCheckpointsRepository, BackfillService, ...(worker ? [SyncScheduler] : [])],
  exports: [SyncCheckpointsRepository, BackfillService],
})
export class SyncModule {}
