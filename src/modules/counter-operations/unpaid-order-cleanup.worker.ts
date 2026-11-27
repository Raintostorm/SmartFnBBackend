import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  OrderPaymentStatus,
  OrderStatus,
  OrderType,
  PaymentStatus,
  Prisma,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import { RealtimePublisher } from '../../realtime/realtime.publisher.js';

/** Shown as the cancellation reason; no employee is recorded as the canceller. */
export const STALE_UNPAID_REASON = 'Tự huỷ: đơn chưa thanh toán quá thời gian chờ';

/**
 * Payment states that still hold (or may still bring) money: such an order is left alone. A QR that is still
 * PENDING is expired first by PaymentExpiryWorker; the order is picked up on a later run.
 */
const LIVE_PAYMENT_STATUSES: PaymentStatus[] = [
  PaymentStatus.PENDING,
  PaymentStatus.SUCCESS,
  PaymentStatus.AMOUNT_MISMATCH,
  PaymentStatus.REQUIRES_ATTENTION,
];

/**
 * Cancels counter orders left "Chờ thanh toán": finalized (CONFIRMED) but never paid and with no live payment for
 * longer than UNPAID_ORDER_TTL_MINUTES. Typical case: the cashier leaves the payment screen and the POS starts a new
 * order, so the old one would otherwise stay in the lists forever. Reserved portions go back to the branch menu,
 * like a cashier cancellation.
 */
@Injectable()
export class UnpaidOrderCleanupWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(UnpaidOrderCleanupWorker.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly realtime: RealtimePublisher,
  ) {}

  onModuleInit() {
    if (!this.config.get<boolean>('UNPAID_ORDER_CLEANUP_ENABLED', true)) return;
    const interval = this.config.get<number>('UNPAID_ORDER_CLEANUP_INTERVAL_MS', 5 * 60_000);
    this.timer = setInterval(() => void this.runOnce(), interval);
    this.timer.unref();
    void this.runOnce();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Orders that qualify; the same condition is checked again when cancelling each one. */
  staleWhere(now = new Date()): Prisma.OrderWhereInput {
    const ttlMinutes = this.config.get<number>('UNPAID_ORDER_TTL_MINUTES', 30);
    return {
      type: OrderType.COUNTER_PICKUP,
      status: OrderStatus.CONFIRMED,
      paymentStatus: OrderPaymentStatus.UNPAID,
      updatedAt: { lte: new Date(now.getTime() - ttlMinutes * 60_000) },
      payments: { none: { status: { in: LIVE_PAYMENT_STATUSES } } },
    };
  }

  async runOnce(now = new Date()): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const batchSize = this.config.get<number>('UNPAID_ORDER_CLEANUP_BATCH_SIZE', 100);
      const stale = await this.prisma.order.findMany({
        where: this.staleWhere(now),
        select: { id: true },
        orderBy: { updatedAt: 'asc' },
        take: batchSize,
      });
      let cancelled = 0;
      for (const { id } of stale) {
        try {
          const branchId = await this.cancel(id, now);
          if (branchId) {
            cancelled += 1;
            this.realtime.branch(branchId, 'cashier.order.updated', { orderId: id, status: OrderStatus.CANCELLED, reason: 'STALE_UNPAID' });
          }
        } catch (error) {
          this.logger.warn(`Could not cancel stale unpaid order ${id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (cancelled) this.logger.log(`Cancelled ${cancelled} stale unpaid order(s)`);
      return cancelled;
    } catch (error) {
      this.logger.error('Failed to clean up stale unpaid orders', error instanceof Error ? error.stack : error);
      return 0;
    } finally {
      this.running = false;
    }
  }

  /** Cancels one order if it still qualifies; returns its branch, or null when something changed meanwhile. */
  private cancel(orderId: string, now: Date): Promise<string | null> {
    return this.prisma.$transaction(
      async (tx) => {
        const order = await tx.order.findFirst({
          where: { id: orderId, ...this.staleWhere(now) },
          select: { branchId: true, items: { select: { menuItemId: true, quantity: true } } },
        });
        if (!order) return null;
        const changed = await tx.order.updateMany({
          where: { id: orderId, ...this.staleWhere(now) },
          data: { status: OrderStatus.CANCELLED, cancelledAt: now, cancellationReason: STALE_UNPAID_REASON },
        });
        if (!changed.count) return null;
        for (const item of order.items) {
          if (!item.menuItemId) continue;
          await tx.branchMenuItem.updateMany({
            where: { branchId: order.branchId, menuItemId: item.menuItemId, remainingPortions: { not: null } },
            data: { remainingPortions: { increment: item.quantity } },
          });
        }
        return order.branchId;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }
}
