import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomInt } from 'node:crypto';
import {
  BusinessSubscriptionStatus,
  Prisma,
  SubscriptionCheckoutStatus,
  SubscriptionEventType,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { AuthenticatedUser } from '../auth/auth.interfaces.js';
import { BranchAccessService } from '../branches/branch-access.service.js';
import { PayosApiService, type PayosCredentials } from '../payos/payos-api.service.js';
import { verifyPayosSignature } from '../payos/payos-signature.js';

type PlatformWebhook = {
  code?: string;
  success?: boolean;
  signature?: string;
  data?: Record<string, unknown> & { orderCode?: number; amount?: number };
};

@Injectable()
export class PlatformBillingService {
  private readonly logger = new Logger(PlatformBillingService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly access: BranchAccessService,
    private readonly payos: PayosApiService,
  ) {}

  async createCheckout(user: AuthenticatedUser, chainId: string, planId: string) {
    await this.access.assertCanAccessChain(user, chainId);
    const [subscription, plan] = await Promise.all([
      this.prisma.businessSubscription.findUnique({ where: { chainId }, include: { plan: true } }),
      this.prisma.servicePlan.findUnique({ where: { id: planId } }),
    ]);
    if (!subscription) throw new NotFoundException('Business subscription not found');
    if (
      subscription.plan.code !== 'TRIAL' ||
      !subscription.trialStartedAt ||
      subscription.trialConvertedAt
    ) {
      throw new ConflictException('This checkout is only available for a trial business');
    }
    if (subscription.status === BusinessSubscriptionStatus.SUSPENDED) {
      throw new ConflictException('A suspended business cannot start checkout');
    }
    if (!plan?.isActive || plan.code === 'TRIAL' || plan.monthlyPrice.lte(0)) {
      throw new BadRequestException('Select an active paid service plan');
    }
    const amount = Number(plan.monthlyPrice);
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new BadRequestException('PayOS requires a whole VND plan price');
    }
    const credentials = this.credentials();
    const pending = await this.prisma.subscriptionCheckout.findFirst({
      where: { chainId, status: SubscriptionCheckoutStatus.PENDING },
      orderBy: { createdAt: 'desc' },
    });
    if (pending && Date.now() - pending.createdAt.getTime() < 15 * 60_000) {
      if (pending.planId === planId && pending.checkoutUrl) return this.view(pending);
      throw new ConflictException('A platform checkout is already in progress');
    }
    if (pending) {
      await this.prisma.subscriptionCheckout.updateMany({
        where: { id: pending.id, status: SubscriptionCheckoutStatus.PENDING },
        data: { status: SubscriptionCheckoutStatus.FAILED },
      });
    }

    const orderCode = String(Date.now() * 1000 + randomInt(0, 1000));
    let checkout;
    try {
      checkout = await this.prisma.subscriptionCheckout.create({
        data: { chainId, planId, amount, providerOrderCode: orderCode },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('A platform checkout is already in progress; please retry');
      }
      throw error;
    }
    const webUrl = this.config.get<string>('PUBLIC_WEB_URL')!.replace(/\/+$/, '');
    try {
      const created = await this.payos.createPayment(credentials, {
        orderCode: Number(orderCode),
        amount,
        description: `SmartFnB ${plan.code}`.slice(0, 25),
        returnUrl: `${webUrl}/owner/plan?checkout=${checkout.id}`,
        cancelUrl: `${webUrl}/owner/plan?checkout=${checkout.id}&cancelled=1`,
        expiredAt: Math.floor(Date.now() / 1000) + 15 * 60,
      });
      return this.view(
        await this.prisma.subscriptionCheckout.update({
          where: { id: checkout.id },
          data: { checkoutUrl: created.checkoutUrl, paymentLinkId: created.paymentLinkId },
        }),
      );
    } catch (error) {
      await this.prisma.subscriptionCheckout.update({
        where: { id: checkout.id },
        data: { status: SubscriptionCheckoutStatus.FAILED },
      });
      throw error;
    }
  }

  async getCheckout(user: AuthenticatedUser, chainId: string, checkoutId: string) {
    await this.access.assertCanAccessChain(user, chainId);
    const checkout = await this.prisma.subscriptionCheckout.findFirst({
      where: { id: checkoutId, chainId },
    });
    if (!checkout) throw new NotFoundException('Subscription checkout not found');
    return this.view(checkout);
  }

  async confirmWebhook() {
    const url = this.config.get<string>('PLATFORM_PAYOS_WEBHOOK_URL')?.trim();
    if (!url || !url.startsWith('https://')) {
      throw new ServiceUnavailableException('PLATFORM_PAYOS_WEBHOOK_URL must be an HTTPS URL');
    }
    await this.payos.confirmWebhook(this.credentials(), url);
    return { confirmed: true, webhookUrl: url };
  }

  async webhook(payload: PlatformWebhook) {
    const data = payload.data;
    if (!data || !payload.signature || !Number.isSafeInteger(data.orderCode)) {
      throw new UnauthorizedException('Invalid platform PayOS webhook');
    }
    if (!verifyPayosSignature(data, payload.signature, this.credentials().checksumKey)) {
      throw new UnauthorizedException('Invalid platform PayOS signature');
    }
    // PayOS may send a signed verification sample before any checkout exists.
    const checkout = await this.prisma.subscriptionCheckout.findUnique({
      where: { providerOrderCode: String(data.orderCode) },
    });
    if (!checkout || payload.code !== '00' || payload.success !== true) return { success: true };
    const result = await this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${checkout.providerOrderCode}))`;
        const fresh = await tx.subscriptionCheckout.findUniqueOrThrow({
          where: { id: checkout.id },
        });
        if (fresh.status === SubscriptionCheckoutStatus.PAID || fresh.status === SubscriptionCheckoutStatus.NEEDS_REVIEW) return 'duplicate';
        if (typeof data.amount !== 'number' || !Number.isSafeInteger(data.amount) || !fresh.amount.equals(data.amount)) {
          await tx.subscriptionCheckout.update({ where: { id: fresh.id }, data: { status: SubscriptionCheckoutStatus.NEEDS_REVIEW, paidAt: new Date(), reviewReason: 'SIGNED_AMOUNT_MISMATCH' } });
          return 'review';
        }
        const subscription = await tx.businessSubscription.findUnique({
          where: { chainId: fresh.chainId },
          include: { plan: true },
        });
        if (!subscription || subscription.plan.code !== 'TRIAL' || subscription.trialConvertedAt) {
          await tx.subscriptionCheckout.update({ where: { id: fresh.id }, data: { status: SubscriptionCheckoutStatus.NEEDS_REVIEW, paidAt: new Date(), reviewReason: 'TRIAL_ALREADY_CONVERTED' } });
          return 'review';
        }
        const now = new Date();
        await tx.businessSubscription.update({
          where: { id: subscription.id },
          data: {
            planId: fresh.planId,
            monthlyPrice: fresh.amount,
            status: BusinessSubscriptionStatus.ACTIVE,
            startsAt: now,
            expiresAt: this.addMonth(now),
            trialConvertedAt: now,
          },
        });
        await tx.businessSubscriptionEvent.create({
          data: {
            subscriptionId: subscription.id,
            type: SubscriptionEventType.UPGRADED,
            fromPlanId: subscription.planId,
            toPlanId: fresh.planId,
            effectiveAt: now,
            note: `PayOS platform checkout ${fresh.id}`,
          },
        });
        await tx.subscriptionCheckout.update({
          where: { id: fresh.id },
          data: { status: SubscriptionCheckoutStatus.PAID, paidAt: now },
        });
        return 'paid';
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    if (result === 'review') this.logger.error(`Platform checkout ${checkout.id} was paid but requires manual reconciliation`);
    return { success: true };
  }

  private credentials(): PayosCredentials {
    const clientId = this.config.get<string>('PLATFORM_PAYOS_CLIENT_ID')?.trim();
    const apiKey = this.config.get<string>('PLATFORM_PAYOS_API_KEY')?.trim();
    const checksumKey = this.config.get<string>('PLATFORM_PAYOS_CHECKSUM_KEY')?.trim();
    if (!clientId || !apiKey || !checksumKey) {
      throw new ServiceUnavailableException('Platform PayOS credentials are not configured');
    }
    return { clientId, apiKey, checksumKey };
  }

  private addMonth(date: Date): Date {
    const result = new Date(date);
    const day = result.getUTCDate();
    result.setUTCDate(1);
    result.setUTCMonth(result.getUTCMonth() + 1);
    const lastDay = new Date(
      Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
    ).getUTCDate();
    result.setUTCDate(Math.min(day, lastDay));
    return result;
  }

  private view(checkout: {
    id: string;
    planId: string;
    amount: Prisma.Decimal;
    status: SubscriptionCheckoutStatus;
    checkoutUrl: string | null;
    paidAt: Date | null;
  }) {
    return {
      id: checkout.id,
      planId: checkout.planId,
      amount: Number(checkout.amount),
      status: checkout.status,
      checkoutUrl: checkout.checkoutUrl,
      paidAt: checkout.paidAt,
    };
  }
}
