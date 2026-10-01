import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator.js';
import { PayosPaymentService } from './payos-payment.service.js';

@Public()
@ApiTags('PayOS webhook')
@Controller('webhooks/payos')
export class PayosWebhookController {
  constructor(private readonly payments: PayosPaymentService) {}

  @Post()
  @HttpCode(200)
  @ApiOperation({ summary: 'Verify and process a PayOS payment notification' })
  receive(@Body() payload: Record<string, unknown>) {
    return this.payments.webhook(payload);
  }
}
