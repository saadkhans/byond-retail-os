import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class AssignRoleDto {
  @ApiProperty({ description: 'Target user id (must belong to the tenant).' })
  @IsString()
  @MinLength(1)
  userId!: string;
}
