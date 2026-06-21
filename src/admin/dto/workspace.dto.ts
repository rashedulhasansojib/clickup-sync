import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';

export class CreateWorkspaceDto {
  @ApiProperty({ description: 'Display name for this workspace connection (e.g. "Denowatts").' })
  @IsString()
  @MinLength(1)
  name!: string;

  @ApiProperty({ description: 'ClickUp Team/Workspace ID.' })
  @IsString()
  @MinLength(1)
  teamId!: string;

  @ApiPropertyOptional({ description: 'ClickUp API token (write-only; stored encrypted). Omit to use the shared CLICKUP_API_TOKEN.' })
  @IsOptional()
  @IsString()
  apiToken?: string;

  @ApiPropertyOptional({ description: 'Override the webhook endpoint base. Usually left unset.' })
  @IsOptional()
  @IsString()
  webhookEndpoint?: string;

  @ApiPropertyOptional({ description: 'Comma-separated subscribed webhook event types. Omit for the default set.' })
  @IsOptional()
  @IsString()
  webhookEvents?: string;
}

export class UpdateWorkspaceDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  teamId?: string;

  @ApiPropertyOptional({ description: 'ClickUp API token (write-only; stored encrypted). Omit to leave unchanged.' })
  @IsOptional()
  @IsString()
  apiToken?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  webhookEndpoint?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  webhookEvents?: string;

  @ApiPropertyOptional({ description: 'Absolute daily-hours cap for spike detection (1–24).', minimum: 1, maximum: 24 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(24)
  spikeHoursCap?: number;

  @ApiPropertyOptional({ enum: ['ACTIVE', 'DISABLED'] })
  @IsOptional()
  @IsIn(['ACTIVE', 'DISABLED'])
  status?: 'ACTIVE' | 'DISABLED';

  @ApiPropertyOptional({ description: 'Per-workspace sync preferences (deep-merged).' })
  @IsOptional()
  @IsObject()
  sync?: Record<string, unknown>;
}

export class UpsertWorkspaceSpaceDto {
  @ApiProperty({ description: 'ClickUp space id.' })
  @IsString()
  @MinLength(1)
  spaceId!: string;

  @ApiProperty({ description: 'Display name for the space.' })
  @IsString()
  @MinLength(1)
  name!: string;

  @ApiPropertyOptional({ description: 'Default backfill lookback (days) for this space.', minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  backfillLookbackDays?: number;

  @ApiPropertyOptional({ description: 'Whether scheduled reconciliation syncs this space.' })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
