import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { BusinessSubscriptionStatus } from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import { SubscriptionScheduleService } from '../subscription/subscription-schedule.service.js';
import { EmailOutboxService } from '../email/email-outbox.service.js';

const DAY = 86_400_000;
/** Paid-subscription reminder milestones in days before the expiry date (BR-69, 25.5). */
export const RENEWAL_MILESTONES = [7, 3, 0] as const;

/** Calendar days between two instants in Vietnam time (the expiry date is the last usable day). */
export function vnDaysUntil(target: Date, now: Date) {
  const day = (value: Date) => {
    const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(value)
      .split('-')
      .map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((day(target) - day(now)) / DAY);
}

/** The single milestone due now, so a late first run sends the current reminder, not every missed one. */
export function dueMilestone(daysLeft: number) {
  if (daysLeft < 0) return null;
  return [...RENEWAL_MILESTONES].reverse().find((milestone) => daysLeft <= milestone) ?? null;
}

/**
 * Minute job (idempotent on every instance): start due periods, issue next-period invoices 7 days
 * ahead, send the 7/3/0-day reminders once per (subscription, period end, milestone) and retry
 * queued subscription notices (receipts, registrations).
 */
@Injectable()
export class SubscriptionInvoiceWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SubscriptionInvoiceWorker.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly schedule: SubscriptionScheduleService,
    @Optional() private readonly emails?: EmailOutboxService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.runOnce(), 60_000);
    this.timer.unref();
    void this.runOnce();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(now = new Date()) {
    if (this.running) return;
    this.running = true;
    try {
      await this.activatePeriods(now);
      await this.issueInvoices(now);
      await this.sendReminders(now);
      await this.retryNotices();
    } catch (error) {
      this.logger.error('Subscription invoice job failed', error instanceof Error ? error.stack : error);
    } finally {
      this.running = false;
    }
  }

  private async activatePeriods(now: Date) {
    const [pending, periods] = await Promise.all([
      this.prisma.businessSubscription.findMany({ where: { pendingPlanId: { not: null }, pendingStartsAt: { lte: now } }, select: { chainId: true }, take: 500 }),
      this.prisma.subscriptionPeriod.findMany({ where: { appliedAt: null, startsAt: { lte: now } }, select: { chainId: true }, take: 500 }),
    ]);
    for (const chainId of new Set([...pending, ...periods].map((row) => row.chainId))) {
      try {
        await this.schedule.activateDue(chainId);
      } catch (error) {
        this.logger.warn(`Could not activate subscription period for ${chainId}: ${String(error)}`);
      }
    }
  }

  private async issueInvoices(now: Date) {
    const subscriptions = await this.prisma.businessSubscription.findMany({
      where: {
        status: BusinessSubscriptionStatus.ACTIVE,
        plan: { code: { not: 'TRIAL' } },
        pendingStartsAt: null,
        invoices: { none: { status: 'PENDING' } },
        expiresAt: { gt: now, lte: new Date(now.getTime() + 7 * DAY) },
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
  }

  /** "Sắp tới hạn" (7), "Nhắc thanh toán" (3), "Đến hạn" (0); skipped once the next period is paid. */
  async sendReminders(now = new Date()) {
    const subscriptions = await this.prisma.businessSubscription.findMany({
      where: {
        status: BusinessSubscriptionStatus.ACTIVE,
        plan: { code: { not: 'TRIAL' } },
        pendingStartsAt: null,
        expiresAt: { gt: new Date(now.getTime() - DAY), lte: new Date(now.getTime() + 8 * DAY) },
      },
      select: { id: true, chainId: true, expiresAt: true, invoices: { where: { status: 'PENDING' }, include: { lines: true }, take: 1 } },
      take: 500,
    });
    const ids: string[] = [];
    for (const subscription of subscriptions) {
      const milestone = dueMilestone(vnDaysUntil(subscription.expiresAt, now));
      if (milestone === null) continue;
      const invoice = subscription.invoices[0];
      const expiry = subscription.expiresAt.toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
      const heading = milestone === 7 ? 'Sắp tới hạn thanh toán thuê bao' : milestone === 3 ? 'Nhắc thanh toán thuê bao' : 'Hôm nay là ngày cuối của kỳ thuê bao';
      try {
        ids.push(
          ...(await this.schedule.queueNotice(this.prisma, subscription.chainId, `subscription-reminder:${subscription.id}:${subscription.expiresAt.toISOString()}:${milestone}`, {
            subject: `Smart F&B: ${heading.toLowerCase()}`,
            heading,
            paragraphs: [
              invoice
                ? `Hoá đơn kỳ tới: gói ${invoice.planName}, kỳ ${invoice.periodStartsAt.toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })} – ${invoice.periodEndsAt.toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}, số tiền ${invoice.total.toLocaleString('vi-VN')}đ, hạn trả ${expiry}.`
                : `Kỳ hiện tại kết thúc ngày ${expiry}.`,
              milestone === 0
                ? 'Từ ngày mai doanh nghiệp chuyển sang chỉ đọc nếu chưa thanh toán.'
                : 'Gói và hạn mức đăng ký cho kỳ tới chỉ áp dụng từ ngày kỳ mới bắt đầu, kể cả khi thanh toán sớm.',
            ],
            lines: invoice?.lines.map((line) => ({ description: line.description, quantity: line.quantity, amount: line.amount })),
            total: invoice?.total,
          })),
        );
      } catch (error) {
        this.logger.warn(`Could not queue renewal reminder for ${subscription.chainId}: ${String(error)}`);
      }
    }
    return ids;
  }

  private async retryNotices() {
    if (!this.emails) return;
    const queued = await this.prisma.emailOutbox.findMany({
      where: { template: 'SUBSCRIPTION_NOTICE', status: { in: ['PENDING', 'FAILED'] }, attempts: { lt: 5 } },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: 50,
    });
    for (const item of queued) await this.emails.deliver(item.id);
  }
}
