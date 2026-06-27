import { Module } from '@nestjs/common';
import { ClickupModule } from '../clickup/clickup.module';
import { CommentsRepository } from './comments.repository';
import { CommentsService } from './comments.service';

@Module({
  imports: [ClickupModule],
  providers: [CommentsRepository, CommentsService],
  exports: [CommentsRepository, CommentsService],
})
export class CommentsModule {}
