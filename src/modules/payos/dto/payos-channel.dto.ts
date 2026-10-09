import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';
import { PayosChannelStatus } from '../../../generated/prisma/client.js';

export class SavePayosChannelDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  clientId!: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  apiKey!: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  checksumKey!: string;
}

export class PayosChannelResponseDto {
  @ApiProperty() configured!: boolean;

  @ApiPropertyOptional({ format: 'uuid' }) id?: string;

  @ApiPropertyOptional({ enum: PayosChannelStatus, enumName: 'PayosChannelStatus' })
  status?: PayosChannelStatus;

  @ApiPropertyOptional({ example: '03eb', nullable: true }) clientIdLast4?: string | null;

  @ApiPropertyOptional({ example: '1f86', nullable: true }) apiKeyLast4?: string | null;

  @ApiPropertyOptional({ nullable: true }) lastError?: string | null;

  @ApiPropertyOptional({ format: 'date-time', nullable: true }) lastVerifiedAt?: Date | null;

  @ApiPropertyOptional({ format: 'date-time' }) createdAt?: Date;

  @ApiPropertyOptional({ format: 'date-time' }) updatedAt?: Date;
}
