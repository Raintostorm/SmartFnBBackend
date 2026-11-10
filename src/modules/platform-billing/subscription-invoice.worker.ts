import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { BusinessSubscriptionStatus } from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import { SubscriptionScheduleService } from '../subscription/subscription-schedule.service.js';

@Injectable()
export class SubscriptionInvoiceWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SubscriptionInvoiceWorker.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly prisma: PrismaService, private readonly schedule: SubscriptionScheduleService) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.runOnce(), 60_000);
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
      const now = new Date();
      const due = await this.prisma.businessSubscription.findMany({
        where: { pendingPlanId: { not: null }, pendingStartsAt: { lte: now } },
        select: { chainId: true },
        take: 500,
      });
      for (const subscription of due) {
        try {
          await this.schedule.activateDue(subscription.chainId);
        } catch (error) {
          this.logger.warn(`Could not activate subscription period for ${subscription.chainId}: ${String(error)}`);
        }
      }
      const subscriptions = await this.prisma.businessSubscription.findMany({
        where: {
          status: BusinessSubscriptionStatus.ACTIVE,
          plan: { code: { not: 'TRIAL' } },
          pendingStartsAt: null,
          invoices: { none: { status: 'PENDING' } },
          expiresAt: { gt: now, lte: new Date(now.getTime() + 7 * 86_400_000) },
        },
        select: { chainId: true },
        take: 500,
      });
      for (const subscription of subscriptions) {
        try {
          await this.schedule.getOrCreateInvoice(subscription.chainId);
        } catch (error) {
          this.logger.warn(`Could not issue subscription invoice for ${subscription.chainId}: ${String(error)}`);
        }
      }
    } catch (error) {
      this.logger.error('Subscription invoice job failed', error instanceof Error ? error.stack : error);
    } finally {
      this.running = false;
    }
  }
}
