import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  BranchAreaStatus,
  BranchAreaType,
  BranchStatus,
  RestaurantChainStatus,
} from '../../../generated/prisma/client.js';

export class ChainReferenceResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  code!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ enum: RestaurantChainStatus, enumName: 'RestaurantChainStatus' })
  status!: RestaurantChainStatus;
}

export class BranchOperatingHourResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  branchId!: string;

  @ApiProperty({ minimum: 0, maximum: 6, description: '0=Sunday, 6=Saturday' })
  dayOfWeek!: number;

  @ApiPropertyOptional({ example: '08:00' })
  openTime!: string | null;

  @ApiPropertyOptional({ example: '22:00' })
  closeTime!: string | null;

  @ApiProperty()
  isClosed!: boolean;
}

export class BranchSpecialHourResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  branchId!: string;

  @ApiProperty({ format: 'date', example: '2026-09-02' })
  date!: Date;

  @ApiPropertyOptional({ example: '08:00' })
  openTime!: string | null;

  @ApiPropertyOptional({ example: '22:00' })
  closeTime!: string | null;

  @ApiProperty()
  isClosed!: boolean;

  @ApiPropertyOptional()
  note!: string | null;
}

export class BranchAreaResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  branchId!: string;

  @ApiProperty()
  code!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ enum: BranchAreaType, enumName: 'BranchAreaType' })
  type!: BranchAreaType;

  @ApiProperty()
  floor!: number;

  @ApiProperty({ enum: BranchAreaStatus, enumName: 'BranchAreaStatus' })
  status!: BranchAreaStatus;
}

export class BranchResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  chainId!: string;

  @ApiProperty()
  code!: string;

  @ApiProperty()
  name!: string;

  @ApiPropertyOptional()
  phone!: string | null;

  @ApiPropertyOptional()
  email!: string | null;

  @ApiProperty()
  addressLine1!: string;

  @ApiPropertyOptional()
  addressLine2!: string | null;

  @ApiPropertyOptional()
  ward!: string | null;

  @ApiPropertyOptional({ deprecated: true })
  district!: string | null;

  @ApiProperty()
  city!: string;

  @ApiProperty()
  country!: string;

  @ApiProperty()
  timezone!: string;

  @ApiProperty({ enum: BranchStatus, enumName: 'BranchStatus' })
  status!: BranchStatus;

  @ApiProperty({ type: ChainReferenceResponseDto })
  chain!: ChainReferenceResponseDto;

  @ApiPropertyOptional({ type: BranchOperatingHourResponseDto, isArray: true })
  operatingHours?: BranchOperatingHourResponseDto[];

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: Date;
}

export class BranchDetailResponseDto extends BranchResponseDto {
  @ApiProperty({ type: BranchSpecialHourResponseDto, isArray: true })
  specialHours!: BranchSpecialHourResponseDto[];

  @ApiProperty({ type: BranchAreaResponseDto, isArray: true })
  areas!: BranchAreaResponseDto[];
}

export class RestaurantChainResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  code!: string;

  @ApiProperty()
  name!: string;

  @ApiPropertyOptional()
  logoUrl!: string | null;

  @ApiPropertyOptional()
  email!: string | null;

  @ApiPropertyOptional()
  phone!: string | null;

  @ApiPropertyOptional()
  website!: string | null;

  @ApiPropertyOptional()
  taxCode!: string | null;

  @ApiPropertyOptional()
  headquartersAddress!: string | null;

  @ApiProperty()
  timezone!: string;

  @ApiProperty()
  currency!: string;

  @ApiProperty({ enum: RestaurantChainStatus, enumName: 'RestaurantChainStatus' })
  status!: RestaurantChainStatus;

  @ApiPropertyOptional({ type: Object, description: 'Current plan limits and usage snapshot' })
  subscription?: object | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: Date;
}
