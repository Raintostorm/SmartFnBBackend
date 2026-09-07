import { IsEnum } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { UserStatus } from '../../../generated/prisma/client.js';

export class UpdateAccountStatusDto {
  @ApiProperty({
    enum: UserStatus,
    enumName: 'UserStatus',
    example: UserStatus.SUSPENDED,
  })
  @IsEnum(UserStatus)
  status!: UserStatus;
}
