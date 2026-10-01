import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

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
