import { IsString, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RefreshTokenDto {
  @ApiProperty({ description: 'Refresh token returned by login, registration, or refresh' })
  @IsString()
  @MinLength(32)
  refreshToken!: string;
}
