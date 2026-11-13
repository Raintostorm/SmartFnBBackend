import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentProvider, PaymentStatus } from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import { PayosPaymentService } from '../payos/payos-payment.service.js';

@Injectable()
export class PaymentExpiryWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PaymentExpiryWorker.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly payos: PayosPaymentService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    if (!this.config.get<boolean>('PAYMENT_EXPIRY_JOB_ENABLED', true)) return;
    const interval = this.config.get<number>('PAYMENT_EXPIRY_JOB_INTERVAL_MS', 60_000);
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
      const batchSize = this.config.get<number>('PAYMENT_EXPIRY_BATCH_SIZE', 100);
      const expired = await this.prisma.payment.findMany({
        where: {
          provider: PaymentProvider.PAYOS,
          status: PaymentStatus.PENDING,
          orderId: { not: null },
          expiresAt: { lte: new Date() },
        },
        select: { id: true },
        orderBy: { expiresAt: 'asc' },
        take: batchSize,
      });
      let processed = 0;
      for (const payment of expired) {
        try {
          await this.payos.expireDuePayment(payment.id);
          processed += 1;
        } catch (error) {
          this.logger.warn(
            `Could not cancel expired PayOS payment ${payment.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (expired.length) this.logger.log(`Expired ${expired.length} PayOS payment(s)`);
      return processed;
    } catch (error) {
      this.logger.error(
        'Failed to expire PayOS payments',
        error instanceof Error ? error.stack : error,
      );
      return 0;
    } finally {
      this.running = false;
    }
  }
}
