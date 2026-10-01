import { ApiProperty } from '@nestjs/swagger';
import { IsUrl } from 'class-validator';

export class CreatePayosPaymentDto {
  @ApiProperty({ example: 'https://pos.example.com/payment/cancel' })
  @IsUrl({ require_tld: false })
  cancelUrl!: string;

  @ApiProperty({ example: 'https://pos.example.com/payment/success' })
  @IsUrl({ require_tld: false })
  returnUrl!: string;
}
