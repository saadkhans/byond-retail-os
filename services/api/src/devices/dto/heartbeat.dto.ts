import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Heartbeat payload — deliberately minimal. Status is NOT client-selectable:
 * the server decides the transition (PROVISIONED/OFFLINE → ONLINE) and
 * refuses heartbeats from DISABLED/RETIRED devices.
 */
export class HeartbeatDto {
  @ApiPropertyOptional({ example: '1.4.2', maxLength: 60 })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  firmwareVersion?: string;

  @ApiPropertyOptional({ example: '2026.07.1', maxLength: 60 })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  softwareVersion?: string;
}
