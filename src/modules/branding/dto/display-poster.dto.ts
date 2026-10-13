import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsInt, IsString, Length, Max, Min, ValidateIf } from 'class-validator';

export class UpdateDisplayPosterDto {
  @ApiPropertyOptional({ maxLength: 120 })
  @ValidateIf((_object, value) => value !== undefined)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(1, 120)
  title?: string;

  @ApiPropertyOptional()
  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: 10000,
    description: 'Ascending; ties use creation time then ID',
  })
  @ValidateIf((_object, value) => value !== undefined)
  @IsInt()
  @Min(0)
  @Max(10000)
  sortOrder?: number;

  @ApiPropertyOptional({ minimum: 3, maximum: 60, default: 8 })
  @ValidateIf((_object, value) => value !== undefined)
  @IsInt()
  @Min(3)
  @Max(60)
  durationSeconds?: number;
}

export class DisplayPosterResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) chainId!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ example: '/uploads/posters/example.png' }) imageUrl!: string;
  @ApiProperty() enabled!: boolean;
  @ApiProperty() sortOrder!: number;
  @ApiProperty() durationSeconds!: number;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}
