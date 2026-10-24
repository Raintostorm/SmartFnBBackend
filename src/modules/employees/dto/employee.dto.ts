import { Transform, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
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
  role?: AppRole.MANAGER | AppRole.WAITER | AppRole.KITCHEN | AppRole.CASHIER | AppRole.BARISTA;

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
  @ApiProperty({ minLength: 3, maxLength: 500 })
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
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

export class InviteManagerDto {
  @ApiProperty({ example: 'Nguyễn Văn An', maxLength: 200 })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @ApiProperty({ example: 'manager@example.com' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(255)
  email!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  branchId!: string;
}

export class InviteStaffDto extends InviteManagerDto {
  @ApiProperty({ enum: [AppRole.MANAGER, AppRole.CASHIER, AppRole.BARISTA] })
  @IsIn([AppRole.MANAGER, AppRole.CASHIER, AppRole.BARISTA])
  role!: AppRole.MANAGER | AppRole.CASHIER | AppRole.BARISTA;
}

export class StaffInvitationReasonDto {
  @ApiProperty({ minLength: 3, maxLength: 500 })
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

export class SetDirectStaffPasswordDto {
  @ApiProperty({ example: '12345678', minLength: 8, maxLength: 128, writeOnly: true })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;
}
