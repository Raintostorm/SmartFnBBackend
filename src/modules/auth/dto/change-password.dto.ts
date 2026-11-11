import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class ChangePasswordDto {
  @IsString()
  currentPassword!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  @Matches(/[A-Za-z]/)
  @Matches(/[0-9]/)
  newPassword!: string;
}
