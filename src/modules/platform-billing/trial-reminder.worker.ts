import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { BusinessSubscriptionStatus, Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import { EmailOutboxService } from '../email/email-outbox.service.js';

@Injectable()
export class TrialReminderWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TrialReminderWorker.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly emails: EmailOutboxService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    if (this.config.get<string>('TRIAL_REMINDER_JOB_ENABLED') === 'false') return;
    this.timer = setInterval(() => void this.runOnce(), 60 * 60_000);
    this.timer.unref();
    void this.runOnce();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce() {
    if (this.running) return 0;
    this.running = true;
    try {
      const now = new Date();
      const trials = await this.prisma.businessSubscription.findMany({
        where: {
          plan: { code: 'TRIAL' },
          trialConvertedAt: null,
          status: BusinessSubscriptionStatus.ACTIVE,
          expiresAt: { gt: now, lte: new Date(now.getTime() + 7 * 24 * 60 * 60_000) },
        },
        select: {
          id: true,
          expiresAt: true,
          chain: {
            select: {
              name: true,
              ownerAssignments: {
                where: { owner: { deletedAt: null, user: { deletedAt: null } } },
                select: { owner: { select: { user: { select: { email: true } } } } },
              },
            },
          },
        },
      });
      let queued = 0;
      for (const trial of trials) {
        const days = (trial.expiresAt.getTime() - now.getTime()) / (24 * 60 * 60_000);
        const reminderDays = days > 3 ? 7 : days > 1 ? 3 : 1;
        for (const assignment of trial.chain.ownerAssignments) {
          const email = assignment.owner.user.email;
          const recipientHash = createHash('sha256')
            .update(email.toLowerCase())
            .digest('hex')
            .slice(0, 16);
          const dedupeKey = `trial:${trial.id}:${reminderDays}:${recipientHash}`;
          try {
            const outbox = await this.prisma.emailOutbox.create({
              data: {
                dedupeKey,
                recipient: email,
                subject: `SmartFnB: gói dùng thử còn ${reminderDays} ngày`,
                template: 'TRIAL_EXPIRING',
                payload: {
                  businessName: trial.chain.name,
                  daysRemaining: Math.ceil(days),
                  trialEndsAt: trial.expiresAt.toISOString(),
                },
              },
            });
            await this.emails.deliver(outbox.id);
            queued++;
          } catch (error) {
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
              continue;
            throw error;
          }
        }
      }
      const retry = await this.prisma.emailOutbox.findMany({
        where: {
          template: 'TRIAL_EXPIRING',
          status: { in: ['PENDING', 'FAILED'] },
          attempts: { lt: 5 },
        },
        select: { id: true },
        take: 100,
      });
      for (const item of retry) await this.emails.deliver(item.id);
      return queued;
    } catch (error) {
      this.logger.error('Trial reminder job failed', error instanceof Error ? error.stack : error);
      return 0;
    } finally {
      this.running = false;
    }
  }
}
