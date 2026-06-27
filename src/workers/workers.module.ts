import { Module } from '@nestjs/common';
import { QueuesModule } from '../queues/queues.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { TasksModule } from '../tasks/tasks.module';
import { TimeEntriesModule } from '../time-entries/time-entries.module';
import { SyncModule } from '../sync/sync.module';
import { RatesModule } from '../rates/rates.module';
import { JobsModule } from '../jobs/jobs.module';
import { CommentsModule } from '../comments/comments.module';
import { ClickupEventProcessor } from './clickup-event.processor';
import { TaskSyncProcessor } from './task-sync.processor';
import { TimeEntrySyncProcessor } from './time-entry-sync.processor';
import { BackfillProcessor } from './backfill.processor';
import { TimeEntryReplacementProcessor } from './time-entry-replacement.processor';
import { CostRecalcProcessor } from './cost-recalc.processor';
import { CommentSyncProcessor } from './comment-sync.processor';

@Module({ imports: [QueuesModule, WebhooksModule, TasksModule, TimeEntriesModule, SyncModule, RatesModule, JobsModule, CommentsModule], providers: [ClickupEventProcessor, TaskSyncProcessor, TimeEntrySyncProcessor, BackfillProcessor, TimeEntryReplacementProcessor, CostRecalcProcessor, CommentSyncProcessor] })
export class WorkersModule {}
