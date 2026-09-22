import { Transform, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  ArrayUnique,
  IsArray,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { TableStatus } from '../../../generated/prisma/client.js';

export class CreateTableDto {
  @ApiProperty({ example: 'T01', maxLength: 50 })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  @Matches(/^[A-Z0-9_-]+$/)
  code!: string;

  @ApiPropertyOptional({ example: 'Bàn cửa sổ' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({ example: 'Tầng 1' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  area?: string;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  floor = 1;

  @ApiProperty({ example: 4, minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  capacity!: number;

  @ApiPropertyOptional({ type: Number })
  @Type(() => Number)
  @IsNumber()
  @IsOptional()
  positionX?: number;

  @ApiPropertyOptional({ type: Number })
  @Type(() => Number)
  @IsNumber()
  @IsOptional()
  positionY?: number;

  @ApiPropertyOptional({ type: Number, minimum: 0 })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @IsOptional()
  width?: number;

  @ApiPropertyOptional({ type: Number, minimum: 0 })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @IsOptional()
  height?: number;
}

export class UpdateTableDto extends PartialType(CreateTableDto) {}

export class UpdateTableStatusDto {
  @ApiProperty({ enum: TableStatus, enumName: 'TableStatus' })
  @IsEnum(TableStatus)
  status!: TableStatus;
}

export class ReplaceTableAdjacencyDto {
  @ApiProperty({ type: String, isArray: true, format: 'uuid' })
  @IsArray()
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  adjacentTableIds!: string[];
}

export class ReplaceBranchTableAdjacencyDto extends ReplaceTableAdjacencyDto {
  @ApiProperty({ format: 'uuid', description: 'Table whose adjacency set is replaced' })
  @IsUUID()
  tableId!: string;
}

export class TableResponseDto extends CreateTableDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  branchId!: string;

  @ApiProperty({ enum: TableStatus, enumName: 'TableStatus' })
  status!: TableStatus;

  @ApiProperty()
  isActive!: boolean;

  @ApiProperty({ type: String, isArray: true, format: 'uuid' })
  adjacentTableIds!: string[];
}
