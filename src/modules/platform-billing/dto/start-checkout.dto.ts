import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class StartCheckoutDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  planId!: string;
}
