import { Transform } from 'class-transformer';
import {
  IsDateString,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { AppRole, STAFF_ROLES } from '../app-role.enum.js';

export class CreateStaffDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(255)
  email!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  @Matches(/[a-z]/, { message: 'password must contain a lowercase letter' })
  @Matches(/[A-Z]/, { message: 'password must contain an uppercase letter' })
  @Matches(/[0-9]/, { message: 'password must contain a number' })
  password!: string;

  @IsOptional()
  @IsString()
  @Matches(/^\+?[0-9]{8,15}$/, { message: 'phone must contain 8 to 15 digits' })
  phone?: string;

  @IsIn(STAFF_ROLES)
  role!: AppRole.WAITER | AppRole.KITCHEN | AppRole.CASHIER;

  @IsUUID()
  branchId!: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  employeeCode!: string;

  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  firstName!: string;

  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  lastName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  jobTitle?: string;

  @IsOptional()
  @IsDateString({ strict: true })
  dateOfBirth?: string;

  @IsOptional()
  @IsDateString({ strict: true })
  hireDate?: string;
}
