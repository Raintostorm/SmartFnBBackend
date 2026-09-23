import { Type } from 'class-transformer';
import { ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ReservationSource, ReservationStatus } from '../../../generated/prisma/client.js';

export class CreateReservationDto {
  @IsString() @MaxLength(150) guestName!: string;
  @IsString() @MaxLength(20) guestPhone!: string;
  @IsOptional() @IsEmail() @MaxLength(255) guestEmail?: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) partySize!: number;
  @IsDateString() reservationAt!: string;
  @ApiPropertyOptional({ default: 120 })
  @Type(() => Number)
  @IsInt()
  @Min(15)
  @Max(720)
  durationMinutes = 120;
  @ApiPropertyOptional({ enum: ReservationSource, default: ReservationSource.PHONE })
  @IsOptional()
  @IsEnum(ReservationSource)
  source: ReservationSource = ReservationSource.PHONE;
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
}

export class UpdateReservationDto extends PartialType(CreateReservationDto) {}

export class ReservationListQueryDto {
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @IsEnum(ReservationStatus) status?: ReservationStatus;
}

export class AllocateReservationTablesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(8)
  @IsUUID('4', { each: true })
  tableIds!: string[];
}

export class CancelReservationDto {
  @IsString() @MaxLength(500) reason!: string;
}
