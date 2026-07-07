import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';
import {
  MAX_PASSWORD_BYTES,
  MIN_PASSWORD_LENGTH,
} from '../password-hasher';

export class LoginDto {
  @ApiProperty({ example: 'admin@byond.local' })
  @IsEmail()
  email!: string;

  // Max 72: bcrypt's byte limit. The hasher additionally enforces the BYTE
  // length (multibyte UTF-8 can exceed 72 bytes within 72 characters).
  @ApiProperty({
    example: 'your-password',
    minLength: MIN_PASSWORD_LENGTH,
    maxLength: MAX_PASSWORD_BYTES,
  })
  @IsString()
  @MinLength(MIN_PASSWORD_LENGTH)
  @MaxLength(MAX_PASSWORD_BYTES)
  password!: string;
}
