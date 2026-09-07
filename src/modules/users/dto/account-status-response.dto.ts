import { ApiProperty } from '@nestjs/swagger';
import { UserStatus } from '../../../generated/prisma/client.js';
import { AppRole } from '../../auth/app-role.enum.js';

export class AccountStatusResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'customer@example.com' })
  email!: string;

  @ApiProperty({ example: '+84901234567', nullable: true })
  phone!: string | null;

  @ApiProperty({ enum: UserStatus, enumName: 'UserStatus' })
  status!: UserStatus;

  @ApiProperty({ enum: AppRole, enumName: 'AppRole' })
  role!: AppRole;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: Date;
}
