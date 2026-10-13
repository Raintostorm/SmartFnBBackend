import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsUrl, IsUUID, MaxLength, MinLength } from 'class-validator';

export class CreatePayosPaymentDto {
  @ApiProperty({
    format: 'uuid',
    description: 'POS station that will print the paid receipt and pickup ticket',
  })
  @IsUUID()
  stationId!: string;

  @ApiProperty({ example: 'https://pos.example.com/payment/cancel' })
  @IsUrl({ require_tld: false })
  cancelUrl!: string;

  @ApiProperty({ example: 'https://pos.example.com/payment/success' })
  @IsUrl({ require_tld: false })
  returnUrl!: string;
}

export class CancelPayosPaymentDto {
  @ApiProperty({ minLength: 3, maxLength: 500 })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}
