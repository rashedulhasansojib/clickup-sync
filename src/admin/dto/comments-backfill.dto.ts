import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MinLength } from 'class-validator';

export class CommentsBackfillDto {
  @ApiProperty({ example: '3577824', description: 'ClickUp space ID whose known tasks should have their comments backfilled' })
  @IsString()
  @MinLength(1)
  spaceId!: string;

  @ApiPropertyOptional({ example: true, description: 'Allow backfill of a space ID not in the configured spaces list (useful for testing)' })
  @IsOptional()
  @IsBoolean()
  allowUnknownSpaces?: boolean;
}
