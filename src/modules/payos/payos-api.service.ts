import { BadGatewayException, Injectable } from '@nestjs/common';
import { payosSignature } from './payos-signature.js';

export interface PayosCredentials {
  clientId: string;
  apiKey: string;
  checksumKey: string;
}

export interface PayosPaymentRequest {
  orderCode: number;
  amount: number;
  description: string;
  cancelUrl: string;
  returnUrl: string;
  expiredAt?: number;
}

@Injectable()
export class PayosApiService {
  async createPayment(credentials: PayosCredentials, request: PayosPaymentRequest) {
    const signable = {
      amount: request.amount,
      cancelUrl: request.cancelUrl,
      description: request.description,
      orderCode: request.orderCode,
      returnUrl: request.returnUrl,
    };
    const body = { ...request, signature: payosSignature(signable, credentials.checksumKey) };
    let response: Response;
    try {
      response = await fetch('https://api-merchant.payos.vn/v2/payment-requests', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-client-id': credentials.clientId,
          'x-api-key': credentials.apiKey,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new BadGatewayException('PayOS is temporarily unavailable');
    }
    const payload = (await response.json().catch(() => null)) as {
      code?: string;
      desc?: string;
      data?: { checkoutUrl?: string; qrCode?: string; paymentLinkId?: string };
    } | null;
    if (!response.ok || payload?.code !== '00' || !payload.data?.checkoutUrl) {
      throw new BadGatewayException(payload?.desc || 'PayOS rejected the payment request');
    }
    return payload.data;
  }
}
