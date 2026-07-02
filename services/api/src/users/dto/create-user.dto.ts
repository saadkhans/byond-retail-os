import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

// No password field by design: credentials and auth flows are Phase 2.
export class CreateUserDto {
  @ApiProperty({ example: 'jane.doe@example.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'Jane', maxLength: 80 })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  firstName!: string;

  @ApiProperty({ example: 'Doe', maxLength: 80 })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  lastName!: string;
}
