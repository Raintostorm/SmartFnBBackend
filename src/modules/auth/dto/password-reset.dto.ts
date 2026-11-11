import { Transform } from 'class-transformer';
import { IsEmail, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class RequestPasswordResetDto {
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim().toLowerCase() : value)
  @IsEmail()
  @MaxLength(255)
  email!: string;
}

export class RejectPasswordResetDto {
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  note!: string;
}

export class ConfirmPasswordResetDto {
  @IsString()
  @MinLength(32)
  @MaxLength(200)
  token!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  @Matches(/[A-Za-z]/)
  @Matches(/[0-9]/)
  newPassword!: string;
}
