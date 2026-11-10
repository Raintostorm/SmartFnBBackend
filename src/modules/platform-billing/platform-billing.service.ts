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
import { EmailOutboxService } from '../email/email-outbox.service.js';
import { PlatformAdminService } from '../platform-admin/platform-admin.service.js';
import { PayosApiService, type PayosCredentials } from '../payos/payos-api.service.js';
import { verifyPayosSignature } from '../payos/payos-signature.js';
import { addSubscriptionMonth, SubscriptionScheduleService } from '../subscription/subscription-schedule.service.js';

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
    private readonly registrations: PlatformAdminService,
    private readonly emails: EmailOutboxService,
    private readonly schedule: SubscriptionScheduleService,
  ) {}

  async createCheckout(user: AuthenticatedUser, chainId: string, planId: string) {
    await this.access.assertCanAccessChain(user, chainId);
    await this.schedule.activateDue(chainId);
    const [subscription, plan] = await Promise.all([
      this.prisma.businessSubscription.findUnique({ where: { chainId }, include: { plan: true } }),
      this.prisma.servicePlan.findUnique({ where: { id: planId } }),
    ]);
    if (!subscription) throw new NotFoundException('Business subscription not found');
    const isTrial = subscription.plan.code === 'TRIAL' && !!subscription.trialStartedAt && !subscription.trialConvertedAt;
    if (!isTrial && (subscription.plan.code === 'TRIAL' || (subscription.status !== BusinessSubscriptionStatus.ACTIVE && subscription.status !== BusinessSubscriptionStatus.EXPIRED))) throw new ConflictException('Subscription cannot be renewed');
    if (subscription.pendingStartsAt) throw new ConflictException('Upcoming period has already been paid');
    if (!isTrial && planId !== (subscription.nextPlanId ?? subscription.planId)) throw new ConflictException('Checkout must use the scheduled next plan');
    if (!isTrial && subscription.expiresAt.getTime() - Date.now() > 7 * 24 * 60 * 60_000) throw new ConflictException('Renewal opens 7 days before expiry');
    if (subscription.status === BusinessSubscriptionStatus.SUSPENDED) {
      throw new ConflictException('A suspended business cannot start checkout');
    }
    if (!plan?.isActive || plan.code === 'TRIAL' || plan.monthlyPrice.lte(0)) {
      throw new BadRequestException('Select an active paid service plan');
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

    if (isTrial) await this.prisma.subscriptionInvoice.updateMany({ where: { chainId, status: 'PENDING' }, data: { status: 'CANCELLED' } });

    const invoice = isTrial
      ? await this.prisma.subscriptionInvoice.create({
          data: { chainId, subscriptionId: subscription.id, planId, planName: plan.name, periodStartsAt: new Date(), periodEndsAt: addSubscriptionMonth(subscription.expiresAt), total: Number(plan.monthlyPrice), lines: { create: [{ planId, kind: 'PLAN', description: plan.name, quantity: 1, unitPrice: Number(plan.monthlyPrice), amount: Number(plan.monthlyPrice) }] } },
        })
      : await this.schedule.getOrCreateInvoice(chainId);
    const amount = invoice.total;
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new BadRequestException('PayOS requires a whole VND plan price');

    const orderCode = String(Date.now() * 1000 + randomInt(0, 1000));
    let checkout;
    try {
      checkout = await this.prisma.subscriptionCheckout.create({
        data: { chainId, planId, invoiceId: invoice.id, amount, providerOrderCode: orderCode },
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
      const ready = await this.prisma.subscriptionCheckout.update({
          where: { id: checkout.id },
          data: { checkoutUrl: created.checkoutUrl, paymentLinkId: created.paymentLinkId },
        });
      try {
        const ownerEmail = await this.prisma.user.findUnique({ where: { id: user.id }, select: { email: true } });
        if (ownerEmail) {
          const invoice = await this.prisma.emailOutbox.create({ data: { recipient: ownerEmail.email, subject: 'Hóa đơn gói Smart F&B', template: 'PLATFORM_INVOICE', payload: { checkoutUrl: created.checkoutUrl, amount, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() } } });
          await this.emails.deliver(invoice.id);
        }
      } catch (error) { this.logger.warn(`Platform invoice email could not be queued for checkout ${ready.id}: ${String(error)}`); }
      return this.view(ready);
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
    if (!checkout || payload.code !== '00' || payload.success !== true) {
      if (!checkout && payload.code === '00' && payload.success === true) {
        await this.registrations.completePaidActivation(String(data.orderCode), data.amount ?? -1);
      }
      return { success: true };
    }
    const result = await this.settleCheckout(checkout.id, checkout.providerOrderCode, data.amount);
    if (result === 'review') this.logger.error(`Platform checkout ${checkout.id} was paid but requires manual reconciliation`);
    return { success: true };
  }

  async getBusinessBilling(chainId: string) {
    const subscription = await this.prisma.businessSubscription.findUnique({ where: { chainId }, select: { id: true, planId: true, nextPlanId: true, expiresAt: true, status: true } });
    if (!subscription) throw new NotFoundException('Business subscription not found');
    const checkouts = await this.prisma.subscriptionCheckout.findMany({ where: { chainId }, select: { id: true, planId: true, amount: true, status: true, createdAt: true, paidAt: true, reviewReason: true, checkoutUrl: true }, orderBy: { createdAt: 'desc' }, take: 20 });
    return { subscription, checkouts };
  }

  async resendInvoice(chainId: string, note: string, actorUserId: string) {
    const checkout = await this.prisma.subscriptionCheckout.findFirst({ where: { chainId, status: SubscriptionCheckoutStatus.PENDING, checkoutUrl: { not: null } }, orderBy: { createdAt: 'desc' } });
    if (!checkout?.checkoutUrl) throw new ConflictException('No pending platform invoice to resend');
    if (Date.now() - checkout.createdAt.getTime() >= 15 * 60_000) throw new ConflictException('Payment link expired; Owner must create a new checkout');
    const owner = await this.prisma.ownerChainAssignment.findFirst({ where: { chainId, owner: { deletedAt: null, user: { status: 'ACTIVE', deletedAt: null } } }, select: { owner: { select: { user: { select: { email: true } } } } } });
    if (!owner) throw new NotFoundException('Active Owner email not found');
    const email = await this.prisma.$transaction(async (tx) => {
      await tx.platformSupportAction.create({ data: { actorUserId, chainId, action: 'RESEND_PLATFORM_INVOICE', note: note.trim(), details: { checkoutId: checkout.id } } });
      return tx.emailOutbox.create({ data: { recipient: owner.owner.user.email, subject: 'Hóa đơn gói Smart F&B', template: 'PLATFORM_INVOICE', payload: { checkoutUrl: checkout.checkoutUrl, amount: Number(checkout.amount), expiresAt: new Date(checkout.createdAt.getTime() + 15 * 60_000).toISOString() } } });
    });
    const emailStatus = await this.emails.deliver(email.id);
    return { checkoutId: checkout.id, emailStatus };
  }

  async recheckPayment(chainId: string, checkoutId: string, note: string, actorUserId: string) {
    const checkout = await this.prisma.subscriptionCheckout.findFirst({ where: { id: checkoutId, chainId } });
    if (!checkout) throw new NotFoundException('Platform checkout not found');
    const provider = await this.payos.getPayment(this.credentials(), checkout.paymentLinkId ?? checkout.providerOrderCode);
    if (provider.orderCode !== Number(checkout.providerOrderCode)) throw new ConflictException('PayOS order code mismatch');
    let outcome: string = 'pending';
    if (provider.status === 'PAID') {
      outcome = await this.settleCheckout(checkout.id, checkout.providerOrderCode, provider.amountPaid ?? -1);
    }
    await this.prisma.platformSupportAction.create({ data: { actorUserId, chainId, action: 'RECHECK_PLATFORM_PAYMENT', note: note.trim(), details: { checkoutId, providerStatus: provider.status ?? null, outcome } } });
    return { outcome, checkout: await this.prisma.subscriptionCheckout.findUniqueOrThrow({ where: { id: checkoutId }, select: { id: true, status: true, paidAt: true, reviewReason: true } }) };
  }

  async reconcilePending(): Promise<number> {
    const pending = await this.prisma.subscriptionCheckout.findMany({
      where: { status: SubscriptionCheckoutStatus.PENDING, checkoutUrl: { not: null } },
      select: { id: true, providerOrderCode: true, paymentLinkId: true },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    let settled = 0;
    for (const checkout of pending) {
      try {
        const provider = await this.payos.getPayment(this.credentials(), checkout.paymentLinkId ?? checkout.providerOrderCode);
        if (provider.orderCode !== Number(checkout.providerOrderCode) || provider.status !== 'PAID') continue;
        if ((await this.settleCheckout(checkout.id, checkout.providerOrderCode, provider.amountPaid ?? -1)) === 'paid') settled++;
      } catch (error) {
        this.logger.warn(`Could not reconcile platform checkout ${checkout.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return settled;
  }

  async confirmCheckoutManually(checkoutId: string, note: string, actorUserId: string) {
    await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${checkoutId}))`;
        const checkout = await tx.subscriptionCheckout.findUnique({ where: { id: checkoutId } });
        if (!checkout) throw new NotFoundException('Platform checkout not found');
        if (checkout.status !== SubscriptionCheckoutStatus.NEEDS_REVIEW) {
          throw new ConflictException('Only an invoice that needs review can be confirmed manually');
        }
        const invoice = checkout.invoiceId ? await tx.subscriptionInvoice.findUnique({ where: { id: checkout.invoiceId }, include: { lines: true } }) : null;
        if (checkout.invoiceId && (!invoice || invoice.status !== 'PENDING')) throw new ConflictException('Invoice is no longer payable');
        const subscription = await tx.businessSubscription.findUnique({
          where: { chainId: checkout.chainId },
          include: { plan: true },
        });
        const isTrial = subscription?.plan.code === 'TRIAL' && !!subscription.trialStartedAt && !subscription.trialConvertedAt;
        const expectedPlanId = isTrial ? checkout.planId : (subscription?.nextPlanId ?? subscription?.planId);
        if (!subscription || (subscription.status !== BusinessSubscriptionStatus.ACTIVE && subscription.status !== BusinessSubscriptionStatus.EXPIRED) || expectedPlanId !== checkout.planId) {
          throw new ConflictException('Subscription state changed; this invoice cannot be confirmed manually');
        }
        const now = new Date();
        const { periodStart, periodEnd } = await this.schedule.applyPayment(tx, {
          subscription, planId: checkout.planId, invoice, isTrial, now, source: 'MANUAL_CONFIRMATION',
        });
        await this.queueReceipt(tx, checkout.chainId, invoice?.id ?? checkout.id, {
          planName: invoice?.planName ?? (await tx.servicePlan.findUniqueOrThrow({ where: { id: checkout.planId } })).name,
          lines: invoice?.lines ?? [], total: Number(checkout.amount), periodStart, periodEnd, paidAt: now,
        });
        await tx.businessSubscriptionEvent.create({
          data: {
            subscriptionId: subscription.id,
            type: isTrial ? SubscriptionEventType.UPGRADED : checkout.planId === subscription.planId ? SubscriptionEventType.RENEWED : Number(checkout.amount) > Number(subscription.monthlyPrice) ? SubscriptionEventType.UPGRADED : SubscriptionEventType.DOWNGRADED,
            fromPlanId: subscription.planId,
            toPlanId: checkout.planId,
            changedById: actorUserId,
            effectiveAt: periodStart,
            note: `Admin confirmed platform invoice ${checkout.id}: ${note.trim()}`,
          },
        });
        await tx.subscriptionCheckout.update({
          where: { id: checkout.id },
          data: { status: SubscriptionCheckoutStatus.PAID, paidAt: now },
        });
        if (invoice) await tx.subscriptionInvoice.update({ where: { id: invoice.id }, data: { status: 'PAID', paidAt: now } });
        await tx.platformSupportAction.create({
          data: {
            actorUserId,
            chainId: checkout.chainId,
            action: 'CONFIRM_PLATFORM_INVOICE',
            note: note.trim(),
            details: { checkoutId: checkout.id, previousReviewReason: checkout.reviewReason },
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    return this.prisma.subscriptionCheckout.findUniqueOrThrow({
      where: { id: checkoutId },
      select: { id: true, status: true, paidAt: true, reviewReason: true },
    });
  }


  private async settleCheckout(checkoutId: string, orderCode: string, amount: number | undefined): Promise<string> {
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${orderCode}))`;
        const fresh = await tx.subscriptionCheckout.findUniqueOrThrow({
          where: { id: checkoutId },
        });
        const invoice = fresh.invoiceId ? await tx.subscriptionInvoice.findUnique({ where: { id: fresh.invoiceId }, include: { lines: true } }) : null;
        if (fresh.status === SubscriptionCheckoutStatus.PAID || fresh.status === SubscriptionCheckoutStatus.NEEDS_REVIEW) return 'duplicate';
        if (fresh.status !== SubscriptionCheckoutStatus.PENDING) {
          await tx.subscriptionCheckout.update({ where: { id: fresh.id }, data: { status: SubscriptionCheckoutStatus.NEEDS_REVIEW, paidAt: new Date(), reviewReason: 'CHECKOUT_INVALIDATED_BEFORE_PAYMENT' } });
          return 'review';
        }
        if (fresh.invoiceId && (!invoice || invoice.status !== 'PENDING')) {
          await tx.subscriptionCheckout.update({ where: { id: fresh.id }, data: { status: SubscriptionCheckoutStatus.NEEDS_REVIEW, paidAt: new Date(), reviewReason: 'INVOICE_INVALIDATED_BEFORE_PAYMENT' } });
          return 'review';
        }
        if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || !fresh.amount.equals(amount)) {
          await tx.subscriptionCheckout.update({ where: { id: fresh.id }, data: { status: SubscriptionCheckoutStatus.NEEDS_REVIEW, paidAt: new Date(), reviewReason: 'SIGNED_AMOUNT_MISMATCH' } });
          return 'review';
        }
        const subscription = await tx.businessSubscription.findUnique({
          where: { chainId: fresh.chainId },
          include: { plan: true },
        });
        const isTrial = subscription?.plan.code === 'TRIAL' && !!subscription.trialStartedAt && !subscription.trialConvertedAt;
        const expectedPlanId = isTrial ? fresh.planId : (subscription?.nextPlanId ?? subscription?.planId);
        if (!subscription || expectedPlanId !== fresh.planId || (subscription.status !== BusinessSubscriptionStatus.ACTIVE && subscription.status !== BusinessSubscriptionStatus.EXPIRED)) {
          await tx.subscriptionCheckout.update({ where: { id: fresh.id }, data: { status: SubscriptionCheckoutStatus.NEEDS_REVIEW, paidAt: new Date(), reviewReason: 'SUBSCRIPTION_STATE_CHANGED' } });
          return 'review';
        }
        const now = new Date();
        const { periodStart, periodEnd } = await this.schedule.applyPayment(tx, {
          subscription, planId: fresh.planId, invoice, isTrial, now, source: 'PAYOS',
        });
        await this.queueReceipt(tx, fresh.chainId, invoice?.id ?? fresh.id, {
          planName: invoice?.planName ?? (await tx.servicePlan.findUniqueOrThrow({ where: { id: fresh.planId } })).name,
          lines: invoice?.lines ?? [], total: Number(fresh.amount), periodStart, periodEnd, paidAt: now,
        });
        await tx.businessSubscriptionEvent.create({
          data: {
            subscriptionId: subscription.id,
            type: isTrial ? SubscriptionEventType.UPGRADED : fresh.planId === subscription.planId ? SubscriptionEventType.RENEWED : Number(fresh.amount) > Number(subscription.monthlyPrice) ? SubscriptionEventType.UPGRADED : SubscriptionEventType.DOWNGRADED,
            fromPlanId: subscription.planId,
            toPlanId: fresh.planId,
            effectiveAt: periodStart,
            note: `PayOS platform checkout ${fresh.id}`,
          },
        });
        await tx.subscriptionCheckout.update({
          where: { id: fresh.id },
          data: { status: SubscriptionCheckoutStatus.PAID, paidAt: now },
        });
        if (invoice) await tx.subscriptionInvoice.update({ where: { id: invoice.id }, data: { status: 'PAID', paidAt: now } });
        return 'paid';
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  /** 25.3 receipt, queued in the payment transaction; the dedupe key makes webhook replays harmless. */
  private queueReceipt(
    tx: Prisma.TransactionClient,
    chainId: string,
    invoiceOrCheckoutId: string,
    receipt: { planName: string; lines: Array<{ description: string; quantity: number; amount: number }>; total: number; periodStart: Date; periodEnd: Date; paidAt: Date },
  ) {
    const date = (value: Date) => value.toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
    return this.schedule.queueNotice(tx, chainId, `subscription-receipt:${invoiceOrCheckoutId}`, {
      subject: 'Smart F&B: biên nhận thanh toán thuê bao',
      heading: 'Đã nhận thanh toán thuê bao',
      paragraphs: [
        `Mã hoá đơn: ${invoiceOrCheckoutId}. Gói ${receipt.planName}, kỳ ${date(receipt.periodStart)} – ${date(receipt.periodEnd)}.`,
        `Số tiền: ${receipt.total.toLocaleString('vi-VN')}đ, thanh toán lúc ${receipt.paidAt.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}.`,
        `Gói và hạn mức của kỳ này áp dụng từ ${date(receipt.periodStart)}. Biên nhận không phải hoá đơn VAT.`,
      ],
      lines: receipt.lines.map((line) => ({ description: line.description, quantity: line.quantity, amount: line.amount })),
      total: receipt.total,
    });
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
