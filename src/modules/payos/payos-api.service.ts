import { Injectable } from '@nestjs/common';
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

export class PayosApiError extends Error {
  constructor(
    message: string,
    readonly temporary: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'PayosApiError';
  }
}

@Injectable()
export class PayosApiService {
  async confirmWebhook(credentials: PayosCredentials, webhookUrl: string) {
    const payload = await this.request(
      credentials,
      'https://api-merchant.payos.vn/confirm-webhook',
      {
        webhookUrl,
      },
    );
    if (payload.code !== '00')
      throw new PayosApiError(payload.desc || 'PayOS rejected the webhook', false);
    return payload.data;
  }

  async createPayment(credentials: PayosCredentials, request: PayosPaymentRequest) {
    const signable = {
      amount: request.amount,
      cancelUrl: request.cancelUrl,
      description: request.description,
      orderCode: request.orderCode,
      returnUrl: request.returnUrl,
    };
    const body = { ...request, signature: payosSignature(signable, credentials.checksumKey) };
    const payload = await this.request(
      credentials,
      'https://api-merchant.payos.vn/v2/payment-requests',
      body,
    );
    const data = payload.data as
      { checkoutUrl?: string; qrCode?: string; paymentLinkId?: string } | undefined;
    if (payload.code !== '00' || !data?.checkoutUrl) {
      throw new PayosApiError(payload.desc || 'PayOS rejected the payment request', false);
    }
    return data;
  }

  private async request(credentials: PayosCredentials, url: string, body: unknown) {
    let response: Response;
    try {
      response = await fetch(url, {
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
      throw new PayosApiError('PayOS is temporarily unavailable', true);
    }
    const payload = (await response.json().catch(() => null)) as {
      code?: string;
      desc?: string;
      data?: unknown;
    } | null;
    if (!response.ok || !payload) {
      throw new PayosApiError(
        payload?.desc || `PayOS request failed (${response.status})`,
        response.status === 429 || response.status >= 500,
        response.status,
      );
    }
    return payload;
  }
}
