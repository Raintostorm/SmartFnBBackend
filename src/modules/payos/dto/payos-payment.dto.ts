import { ApiProperty } from '@nestjs/swagger';
import { IsUrl, IsUUID } from 'class-validator';

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
