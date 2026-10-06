import { Injectable } from '@nestjs/common';

interface PendingVerification {
  chainId: string;
  checksumKey: string;
  expiresAt: number;
}

/** Short-lived bridge for the signed sample PayOS sends before a channel is persisted. */
@Injectable()
export class PayosVerificationStore {
  private readonly pending = new Map<string, PendingVerification>();

  put(webhookCode: string, chainId: string, checksumKey: string) {
    this.pending.set(webhookCode, { chainId, checksumKey, expiresAt: Date.now() + 30_000 });
  }

  get(webhookCode: string) {
    const value = this.pending.get(webhookCode);
    if (!value) return null;
    if (value.expiresAt <= Date.now()) {
      this.pending.delete(webhookCode);
      return null;
    }
    return value;
  }

  remove(webhookCode: string) {
    this.pending.delete(webhookCode);
  }
}
