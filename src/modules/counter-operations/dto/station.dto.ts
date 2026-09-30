import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, IsUUID, Length, MaxLength } from 'class-validator';
import { DisplayDeviceType, PrinterConnectionType } from '../../../generated/prisma/client.js';

export class CreateStationDto {
  @ApiProperty({ maxLength: 100 })
  @IsString()
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({ enum: PrinterConnectionType })
  @IsOptional()
  @IsEnum(PrinterConnectionType)
  printerConnection?: PrinterConnectionType;

  @ApiPropertyOptional({ maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  printerAddress?: string;
}

export class CreatePairingCodeDto {
  @ApiProperty({ enum: DisplayDeviceType })
  @IsEnum(DisplayDeviceType)
  deviceType!: DisplayDeviceType;
}

export class PairCustomerDisplayDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  stationId!: string;

  @ApiProperty({ minLength: 6, maxLength: 6 })
  @IsString()
  @Length(6, 6)
  code!: string;

  @ApiPropertyOptional({ maxLength: 150 })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  deviceName?: string;
}
