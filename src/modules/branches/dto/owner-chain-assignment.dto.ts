import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayUnique, IsArray, IsUUID } from 'class-validator';

export class ReplaceOwnerChainsDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    description: 'Complete list of restaurant chains assigned to this owner.',
  })
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(100)
  @IsUUID(undefined, { each: true })
  chainIds!: string[];
}
