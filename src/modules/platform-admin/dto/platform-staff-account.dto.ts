import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

export class CreatePlatformStaffDto {
  @ApiProperty({ example: 'staff@example.com' })
  @IsEmail()
  @MaxLength(255)
  email!: string;

  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  note!: string;
}

export class PlatformStaffAccountNoteDto {
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  note!: string;
}
