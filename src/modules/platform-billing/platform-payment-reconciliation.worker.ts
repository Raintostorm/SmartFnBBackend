import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PlatformBillingService } from './platform-billing.service.js';

@Injectable()
export class PlatformPaymentReconciliationWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PlatformPaymentReconciliationWorker.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly billing: PlatformBillingService) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.runOnce(), 30_000);
    this.timer.unref();
    void this.runOnce();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce() {
    if (this.running) return;
    this.running = true;
    try {
      const settled = await this.billing.reconcilePending();
      if (settled) this.logger.log(`Automatically settled ${settled} platform payment(s)`);
    } catch (error) {
      this.logger.warn(`Platform payment reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.running = false;
    }
  }
}
