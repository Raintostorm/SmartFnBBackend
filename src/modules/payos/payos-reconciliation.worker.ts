import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentProvider, PaymentStatus } from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import { PayosPaymentService } from './payos-payment.service.js';

@Injectable()
export class PayosReconciliationWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PayosReconciliationWorker.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PayosPaymentService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    if (!this.config.get<boolean>('PAYOS_RECONCILIATION_JOB_ENABLED', true)) return;
    const interval = this.config.get<number>('PAYOS_RECONCILIATION_JOB_INTERVAL_MS', 30_000);
    this.timer = setInterval(() => void this.runOnce(), interval);
    this.timer.unref();
    void this.runOnce();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const now = new Date();
      const lookbackMs = this.config.get<number>('PAYOS_RECONCILIATION_LOOKBACK_MS', 30 * 60_000);
      const batchSize = this.config.get<number>('PAYOS_RECONCILIATION_BATCH_SIZE', 20);
      const candidates = await this.prisma.payment.findMany({
        where: {
          provider: PaymentProvider.PAYOS,
          status: PaymentStatus.PENDING,
          orderId: { not: null },
          createdAt: { gte: new Date(now.getTime() - lookbackMs) },
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
        take: batchSize,
      });
      let reconciled = 0;
      for (const candidate of candidates) {
        try {
          const result = await this.payments.reconcilePending(candidate.id);
          if (result?.status !== PaymentStatus.PENDING) reconciled += 1;
        } catch (error) {
          this.logger.warn(
            `Could not reconcile PayOS payment ${candidate.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (reconciled) this.logger.log(`Reconciled ${reconciled} PayOS payment(s)`);
      return reconciled;
    } catch (error) {
      this.logger.error(
        'Failed to reconcile pending PayOS payments',
        error instanceof Error ? error.stack : error,
      );
      return 0;
    } finally {
      this.running = false;
    }
  }
}
