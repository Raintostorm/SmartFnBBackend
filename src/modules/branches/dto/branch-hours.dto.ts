import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export class UpsertBranchHourDto {
  @ApiPropertyOptional({ example: '08:00', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' })
  @IsOptional()
  @IsString()
  @Matches(TIME_PATTERN, { message: 'openTime must use HH:mm in 24-hour format' })
  openTime?: string;

  @ApiPropertyOptional({ example: '22:00', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' })
  @IsOptional()
  @IsString()
  @Matches(TIME_PATTERN, { message: 'closeTime must use HH:mm in 24-hour format' })
  closeTime?: string;

  @ApiProperty({ example: false, default: false })
  @IsBoolean()
  isClosed!: boolean;
}

export class UpsertBranchSpecialHourDto extends UpsertBranchHourDto {
  @ApiPropertyOptional({ example: 'Tet holiday schedule', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
