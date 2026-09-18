import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class SetupPasswordDto {
  @ApiProperty({ description: 'One-time token received in the Owner setup email' })
  @IsString()
  @MinLength(32)
  @MaxLength(200)
  token!: string;

  @ApiProperty({ example: 'StrongPass123', minLength: 8, maxLength: 128, writeOnly: true })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  @Matches(/[a-z]/, { message: 'password must contain a lowercase letter' })
  @Matches(/[A-Z]/, { message: 'password must contain an uppercase letter' })
  @Matches(/[0-9]/, { message: 'password must contain a number' })
  password!: string;
}
