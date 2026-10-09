import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import {
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator.js';
import { PayosPaymentService } from './payos-payment.service.js';

@Public()
@ApiTags('PayOS webhook')
@Controller('webhooks/payos/:webhookCode')
export class PayosWebhookController {
  constructor(private readonly payments: PayosPaymentService) {}

  @Post()
  @HttpCode(200)
  @ApiOperation({ summary: 'Verify and process a PayOS payment notification' })
  @ApiParam({
    name: 'webhookCode',
    format: 'uuid',
    description: 'Opaque code of one PayOS channel',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['code', 'success', 'data', 'signature'],
      properties: {
        code: { type: 'string', example: '00' },
        desc: { type: 'string', example: 'success' },
        success: { type: 'boolean', example: true },
        signature: { type: 'string', description: 'HMAC-SHA256 supplied by PayOS' },
        data: {
          type: 'object',
          required: ['orderCode', 'amount'],
          additionalProperties: true,
          properties: {
            orderCode: { type: 'integer', format: 'int64', example: 1727777000012 },
            amount: { type: 'integer', example: 55000 },
            reference: { type: 'string', example: 'FT24275012345678' },
            paymentLinkId: { type: 'string' },
          },
        },
      },
    },
  })
  @ApiOkResponse({
    description: 'Webhook accepted; duplicate deliveries are handled idempotently',
    schema: { example: { success: true } },
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid PayOS signature' })
  receive(
    @Param('webhookCode', new ParseUUIDPipe()) webhookCode: string,
    @Body() payload: Record<string, unknown>,
  ) {
    return this.payments.webhook(webhookCode, payload);
  }
}
