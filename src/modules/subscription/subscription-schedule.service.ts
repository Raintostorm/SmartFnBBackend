import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { BusinessSubscriptionStatus, Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import { ConfigService } from '@nestjs/config';
import { PayosApiService } from '../payos/payos-api.service.js';

export function addSubscriptionMonth(date: Date): Date {
  const result = new Date(date);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + 1);
  const last = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, last));
  return result;
}

@Injectable()
export class SubscriptionScheduleService {
  constructor(private readonly prisma: PrismaService, private readonly config: ConfigService, private readonly payos: PayosApiService) {}

  async activateDue(chainId: string) {
    const now = new Date();
    const subscription = await this.prisma.businessSubscription.findUnique({ where: { chainId } });
    if (subscription?.pendingStartsAt && subscription.pendingStartsAt <= now && subscription.pendingPlanId) {
      await this.prisma.businessSubscription.updateMany({
        where: { id: subscription.id, pendingStartsAt: subscription.pendingStartsAt, pendingPlanId: subscription.pendingPlanId },
        data: {
          planId: subscription.pendingPlanId,
          monthlyPrice: subscription.pendingMonthlyPrice ?? subscription.monthlyPrice,
          activeExtraBranches: subscription.pendingExtraBranches,
          activeAccountPacks: subscription.pendingAccountPacks,
          startsAt: subscription.pendingStartsAt,
          pendingPlanId: null,
          pendingMonthlyPrice: null,
          pendingStartsAt: null,
          pendingExtraBranches: 0,
          pendingAccountPacks: 0,
        },
      });
    }
  }

  async preview(chainId: string) {
    await this.activateDue(chainId);
    const sub = await this.prisma.businessSubscription.findUnique({ where: { chainId }, include: { plan: true, nextPlan: true } });
    if (!sub) throw new NotFoundException('Business subscription not found');
    const plan = sub.nextPlan ?? sub.plan;
    const extraBranches = sub.nextExtraBranches ?? (sub.nextPlanId && plan.maxBranches >= sub.plan.maxBranches + sub.activeExtraBranches ? 0 : sub.activeExtraBranches);
    const accountPacks = sub.nextAccountPacks ?? sub.activeAccountPacks;
    await this.validateSelection(plan, extraBranches, accountPacks);
    const unit = Number(plan.monthlyPrice);
    if (!Number.isSafeInteger(unit)) throw new BadRequestException('Plan price must be whole VND');
    const lines = [
      { kind: 'PLAN', description: plan.name, quantity: 1, unitPrice: unit, amount: unit },
      ...(extraBranches ? [{ kind: 'EXTRA_BRANCH', description: 'Thêm chi nhánh (kèm tài khoản)', quantity: extraBranches, unitPrice: plan.extraBranchPrice, amount: extraBranches * plan.extraBranchPrice }] : []),
      ...(accountPacks ? [{ kind: 'ACCOUNT_PACK', description: 'Thêm 5 tài khoản', quantity: accountPacks, unitPrice: plan.extraAccountPackPrice, amount: accountPacks * plan.extraAccountPackPrice }] : []),
    ];
    const startsAt = sub.expiresAt > new Date() ? sub.expiresAt : new Date();
    return {
      plan,
      extraBranches,
      accountPacks,
      branchLimit: plan.maxBranches + extraBranches,
      accountLimit: plan.maxAccounts + extraBranches * plan.extraBranchAccounts + accountPacks * 5,
      startsAt,
      endsAt: addSubscriptionMonth(startsAt),
      lines,
      total: lines.reduce((sum, line) => sum + line.amount, 0),
      currentPeriodEndsAt: sub.pendingStartsAt ?? sub.expiresAt,
      paidUpcoming: !!sub.pendingStartsAt,
    };
  }

  async putNextPlan(chainId: string, planId: string) {
    const sub = await this.prisma.businessSubscription.findUnique({ where: { chainId }, include: { plan: true } });
    if (!sub) throw new NotFoundException('Business subscription not found');
    this.assertCanSchedule(sub);
    const plan = await this.prisma.servicePlan.findUnique({ where: { id: planId } });
    if (!plan?.isActive || plan.code === 'TRIAL') throw new BadRequestException('Select an active paid plan');
    const extraBranches = plan.maxBranches >= sub.plan.maxBranches + sub.activeExtraBranches ? 0 : (sub.nextExtraBranches ?? sub.activeExtraBranches);
    await this.validateSelection(plan, extraBranches, sub.nextAccountPacks ?? sub.activeAccountPacks);
    await this.cancelPendingCheckout(chainId);
    await this.prisma.$transaction(async (tx) => {
      await tx.businessSubscription.update({ where: { id: sub.id }, data: { nextPlanId: planId === sub.planId ? null : planId, nextExtraBranches: extraBranches } });
      await this.invalidateUnpaid(tx, chainId);
    });
    return this.preview(chainId);
  }

  async putNextAddons(chainId: string, extraBranches: number, accountPacks: number) {
    const sub = await this.prisma.businessSubscription.findUnique({ where: { chainId }, include: { plan: true, nextPlan: true } });
    if (!sub) throw new NotFoundException('Business subscription not found');
    this.assertCanSchedule(sub);
    await this.validateSelection(sub.nextPlan ?? sub.plan, extraBranches, accountPacks);
    await this.cancelPendingCheckout(chainId);
    await this.prisma.$transaction(async (tx) => {
      await tx.businessSubscription.update({ where: { id: sub.id }, data: { nextExtraBranches: extraBranches, nextAccountPacks: accountPacks } });
      await this.invalidateUnpaid(tx, chainId);
    });
    return this.preview(chainId);
  }

  async clearNextPlan(chainId: string) {
    const sub = await this.prisma.businessSubscription.findUnique({ where: { chainId }, include: { plan: true } });
    if (!sub) throw new NotFoundException('Business subscription not found');
    this.assertCanSchedule(sub);
    await this.validateSelection(sub.plan, sub.activeExtraBranches, sub.activeAccountPacks);
    await this.cancelPendingCheckout(chainId);
    await this.prisma.$transaction(async (tx) => {
      await tx.businessSubscription.update({ where: { id: sub.id }, data: { nextPlanId: null, nextExtraBranches: null, nextAccountPacks: null } });
      await this.invalidateUnpaid(tx, chainId);
    });
    return this.preview(chainId);
  }

  async getOrCreateInvoice(chainId: string) {
    const preview = await this.preview(chainId);
    if (preview.paidUpcoming) throw new ConflictException('Upcoming period has already been paid');
    if (preview.currentPeriodEndsAt.getTime() - Date.now() > 7 * 86_400_000) throw new ConflictException('Invoice opens 7 days before expiry');
    const sub = await this.prisma.businessSubscription.findUniqueOrThrow({ where: { chainId } });
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${chainId}))`;
      const existing = await tx.subscriptionInvoice.findFirst({ where: { chainId, status: 'PENDING' }, include: { lines: true } });
      if (existing) return existing;
      return tx.subscriptionInvoice.create({
        data: {
          chainId,
          subscriptionId: sub.id,
          planId: preview.plan.id,
          planName: preview.plan.name,
          periodStartsAt: preview.startsAt,
          periodEndsAt: preview.endsAt,
          total: preview.total,
          lines: { create: preview.lines.map((line) => ({ ...line, planId: preview.plan.id })) },
        },
        include: { lines: true },
      });
    });
  }

  async listInvoices(chainId: string) {
    await this.activateDue(chainId);
    const sub = await this.prisma.businessSubscription.findUnique({ where: { chainId }, include: { plan: true } });
    if (!sub) throw new NotFoundException('Business subscription not found');
    if (sub.plan.code !== 'TRIAL' && !sub.pendingStartsAt && sub.expiresAt.getTime() - Date.now() <= 7 * 86_400_000) {
      await this.getOrCreateInvoice(chainId);
    }
    return this.prisma.subscriptionInvoice.findMany({ where: { chainId }, include: { lines: true }, orderBy: { createdAt: 'desc' }, take: 24 });
  }

  private assertCanSchedule(sub: { status: BusinessSubscriptionStatus; plan: { code: string }; pendingStartsAt: Date | null }) {
    if (sub.plan.code === 'TRIAL' || sub.status === BusinessSubscriptionStatus.SUSPENDED) throw new ConflictException('Cannot schedule during trial or suspension');
    if (sub.pendingStartsAt) throw new ConflictException('Upcoming period is already paid');
  }

  private async validateSelection(plan: { id: string; code: string; monthlyPrice: Prisma.Decimal; maxBranches: number; extraBranchPrice: number; extraBranchAccounts: number; extraAccountPackPrice: number; extraBranchEnabled: boolean }, branches: number, packs: number) {
    if (!Number.isInteger(branches) || branches < 0 || !Number.isInteger(packs) || packs < 0 || packs > 4 || plan.maxBranches + branches > 10) throw new BadRequestException('Invalid add-on quantity');
    if (packs && (plan.code === 'TRIAL' || plan.extraAccountPackPrice <= 0)) throw new ConflictException('This plan does not sell account packs');
    if (branches && (!plan.extraBranchEnabled || plan.extraBranchPrice <= 0 || plan.code === 'TRIAL')) throw new ConflictException('This plan does not sell extra branches');
    if (branches) {
      const next = await this.prisma.servicePlan.findFirst({ where: { isActive: true, code: { not: 'TRIAL' }, maxBranches: { gte: plan.maxBranches + branches } }, orderBy: { monthlyPrice: 'asc' } });
      if (next && Number(plan.monthlyPrice) + branches * plan.extraBranchPrice >= Number(next.monthlyPrice)) {
        throw new ConflictException({ error: 'ADDON_UPGRADE_BETTER', message: `Gói ${next.name} phù hợp hơn mua thêm chi nhánh`, suggestedPlan: next });
      }
    }
  }

  private async invalidateUnpaid(tx: Prisma.TransactionClient, chainId: string) {
    await tx.subscriptionInvoice.updateMany({ where: { chainId, status: 'PENDING' }, data: { status: 'CANCELLED' } });
    await tx.subscriptionCheckout.updateMany({ where: { chainId, status: 'PENDING' }, data: { status: 'FAILED' } });
  }

  private async cancelPendingCheckout(chainId: string) {
    const checkout = await this.prisma.subscriptionCheckout.findFirst({ where: { chainId, status: 'PENDING' }, orderBy: { createdAt: 'desc' } });
    if (!checkout) return;
    if (!checkout.checkoutUrl) throw new ConflictException('A payment link is being created; retry after it is ready');
    const clientId = this.config.get<string>('PLATFORM_PAYOS_CLIENT_ID');
    const apiKey = this.config.get<string>('PLATFORM_PAYOS_API_KEY');
    const checksumKey = this.config.get<string>('PLATFORM_PAYOS_CHECKSUM_KEY');
    if (!clientId || !apiKey || !checksumKey) throw new ConflictException('PayOS is not configured to cancel the old payment link');
    try {
      await this.payos.cancelPayment({ clientId, apiKey, checksumKey }, checkout.paymentLinkId ?? checkout.providerOrderCode, 'Subscription selection changed');
    } catch {
      const state = await this.payos.getPayment({ clientId, apiKey, checksumKey }, checkout.paymentLinkId ?? checkout.providerOrderCode).catch(() => null);
      if (!state || !['CANCELLED', 'EXPIRED'].includes(state.status ?? '')) throw new ConflictException('Could not cancel the current PayOS link; check its status before changing the next period');
    }
    await this.prisma.subscriptionCheckout.updateMany({ where: { id: checkout.id, status: 'PENDING' }, data: { status: 'FAILED' } });
  }
}
