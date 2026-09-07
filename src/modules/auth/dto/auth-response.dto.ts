import { ApiProperty } from '@nestjs/swagger';
import { UserStatus } from '../../../generated/prisma/client.js';
import { AppRole } from '../app-role.enum.js';

export class EmployeeProfileResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'WTR-HCM-001' })
  employeeCode!: string;

  @ApiProperty({ format: 'uuid' })
  branchId!: string;

  @ApiProperty({ example: 'An' })
  firstName!: string;

  @ApiProperty({ example: 'Nguyen' })
  lastName!: string;
}

export class CustomerProfileResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'CUS-A1B2C3D4E5F6' })
  customerCode!: string;

  @ApiProperty({ example: 'An' })
  firstName!: string;

  @ApiProperty({ example: 'Nguyen' })
  lastName!: string;
}

export class AuthUserResponseDto {
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

  @ApiProperty({ type: EmployeeProfileResponseDto, nullable: true })
  employee!: EmployeeProfileResponseDto | null;

  @ApiProperty({ type: CustomerProfileResponseDto, nullable: true })
  customer!: CustomerProfileResponseDto | null;
}

export class AuthResponseDto {
  @ApiProperty({ type: AuthUserResponseDto })
  user!: AuthUserResponseDto;

  @ApiProperty({ description: 'JWT used in the Authorization Bearer header' })
  accessToken!: string;

  @ApiProperty({ description: 'Single-use token used to obtain a new token pair' })
  refreshToken!: string;

  @ApiProperty({ example: 'Bearer' })
  tokenType!: 'Bearer';

  @ApiProperty({ example: 900, description: 'Access-token lifetime in seconds' })
  expiresIn!: number;

  @ApiProperty({ example: 604800, description: 'Refresh-token lifetime in seconds' })
  refreshExpiresIn!: number;
}

export class AuthenticatedUserResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'customer@example.com' })
  email!: string;

  @ApiProperty({ example: '+84901234567', nullable: true })
  phone!: string | null;

  @ApiProperty({ enum: AppRole, enumName: 'AppRole' })
  role!: AppRole;

  @ApiProperty({ format: 'uuid' })
  sessionId!: string;

  @ApiProperty({ format: 'uuid', nullable: true })
  employeeId!: string | null;

  @ApiProperty({ format: 'uuid', nullable: true })
  customerId!: string | null;

  @ApiProperty({ format: 'uuid', nullable: true })
  branchId!: string | null;
}

export class MessageResponseDto {
  @ApiProperty({ example: 'Logged out successfully' })
  message!: string;
}
