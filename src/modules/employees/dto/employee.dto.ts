import { Transform, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { UserStatus } from '../../../generated/prisma/client.js';
import { AppRole, STAFF_ROLES } from '../../auth/app-role.enum.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class ListEmployeesQueryDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Restrict to one branch' })
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional({ enum: STAFF_ROLES, enumName: 'StaffRole' })
  @IsOptional()
  @IsIn(STAFF_ROLES)
  role?: AppRole.MANAGER | AppRole.WAITER | AppRole.KITCHEN | AppRole.CASHIER;

  @ApiPropertyOptional({ enum: UserStatus, enumName: 'UserStatus' })
  @IsOptional()
  @IsEnum(UserStatus)
  status?: UserStatus;

  @ApiPropertyOptional({ example: 'nguyen', description: 'Matches name, employee code, or email' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(150)
  search?: string;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}

export class UpdateEmployeeAccountStatusDto {
  @ApiProperty({
    enum: UserStatus,
    enumName: 'UserStatus',
    description: 'Anything other than ACTIVE locks the account and revokes its sessions',
  })
  @IsEnum(UserStatus)
  status!: UserStatus;
}

export class TransferEmployeeBranchDto {
  @ApiProperty({ format: 'uuid', description: 'Target branch, inside the same restaurant chain' })
  @IsUUID()
  branchId!: string;
}
