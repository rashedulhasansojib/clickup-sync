import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsObject, IsOptional } from 'class-validator';

/**
 * App-global preferences only (notifications / cost / failure). Per-connection
 * ClickUp settings (token, team id, webhook secret/endpoint/events, spike cap)
 * and per-workspace sync prefs live on the Workspace and are edited via the
 * /admin/workspaces endpoints.
 */
export class UpdateSettingsDto {
  @ApiPropertyOptional({ description: 'App-global preferences (notifications, cost rules, failure-retry). Deep-merged.' })
  @IsOptional()
  @IsObject()
  preferences?: Record<string, unknown>;
}
