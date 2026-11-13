import { Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsString, Matches, MaxLength, MinLength, ValidateIf } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/**
 * CM-02 self-service profile. Email is the login identity tied to password links and is not
 * accepted here (unknown fields are rejected by the global ValidationPipe).
 */
export class UpdateProfileDto {
  @ApiPropertyOptional({ maxLength: 100, description: 'Family / middle name' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  firstName?: string;

  @ApiPropertyOptional({ maxLength: 100, description: 'Given name (may be empty)' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  lastName?: string;

  @ApiPropertyOptional({ nullable: true, example: '0901234567', description: 'Vietnamese phone (0… or +84…); null clears it' })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.replace(/[\s.-]/g, '') || null : value))
  @ValidateIf((_, value) => value !== null)
  @Matches(/^(\+84|0)\d{9,10}$/, { message: 'phone must be a valid Vietnamese phone number' })
  phone?: string | null;

  @ApiPropertyOptional({ nullable: true, format: 'date', example: '1995-04-30' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsDateString({ strict: true })
  dateOfBirth?: string | null;
}
