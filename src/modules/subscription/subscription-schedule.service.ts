import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { BranchStatus, BusinessSubscriptionStatus, Prisma, UserStatus } from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import { ConfigService } from '@nestjs/config';
import { PayosApiService } from '../payos/payos-api.service.js';
import {
  addonViolation,
  carryOverAddons,
  computeLimits,
  invoiceLines,
  isPaidPlan,
  maxSellableExtraBranches,
  type PlanPricing,
  type Selection,
  toVnd,
} from './subscription-limits.js';
import { countUsage, listCountedUsage } from './subscription-usage.js';

export function addSubscriptionMonth(date: Date): Date {
  const result = new Date(date);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + 1);
  const last = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, last));
  return result;
}

/** Audit rows written by the period-start job have no human actor. */
export const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000';
export const OVER_QUOTA_REASON = 'vượt hạn mức gói';

export type RegistrationActorRole = 'BRAND_MANAGER' | 'PLATFORM_STAFF' | 'PLATFORM_ADMIN';
export interface RegistrationActor {
  role: RegistrationActorRole;
  userId: string;
  note?: string;
}
export interface NextPeriodInput {
  planId?: string;
  extraBranches?: number;
  accountPacks?: number;
  keepBranchIds?: string[];
  keepAccountIds?: string[];
}

type Plan = PlanPricing & {
  maxTables: number;
  brandingEnabled: boolean;
  multiBranchComparisonEnabled: boolean;
  monthlyPrice: Prisma.Decimal;
  isActive: boolean;
};

type SubscriptionWithPlans = Prisma.BusinessSubscriptionGetPayload<{
  include: { plan: true; nextPlan: true; pendingPlan: true };
}>;

type InvoiceWithLines = Prisma.SubscriptionInvoiceGetPayload<{ include: { lines: true } }>;

const toIdList = (value: Prisma.JsonValue | null | undefined): string[] | null =>
  Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : null;

@Injectable()
export class SubscriptionScheduleService {
  private readonly logger = new Logger(SubscriptionScheduleService.name);
  constructor(private readonly prisma: PrismaService, private readonly config: ConfigService, private readonly payos: PayosApiService) {}

  // ---------------------------------------------------------------- period transitions

  /**
   * Starts every period whose start date has passed: promotes the paid upcoming plan and applies the
   * BR-11 keep selection. Serialised per chain with an advisory lock and guarded by `appliedAt`, so
   * concurrent instances and repeated job runs apply each period exactly once.
   */
  async activateDue(chainId: string) {
    const now = new Date();
    const subscription = await this.prisma.businessSubscription.findUnique({
      where: { chainId },
      select: { id: true, pendingPlanId: true, pendingStartsAt: true },
    });
    if (!subscription) return;
    const pendingDue = !!subscription.pendingPlanId && !!subscription.pendingStartsAt && subscription.pendingStartsAt <= now;
    const periodDue = await this.prisma.subscriptionPeriod.findFirst({
      where: { subscriptionId: subscription.id, appliedAt: null, startsAt: { lte: now } },
      select: { id: true },
    });
    if (!pendingDue && !periodDue) return;
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`subscription:${chainId}`}))`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`quota:${chainId}`}))`;
      const fresh = await tx.businessSubscription.findUnique({ where: { id: subscription.id } });
      if (fresh?.pendingPlanId && fresh.pendingStartsAt && fresh.pendingStartsAt <= now) {
        await tx.businessSubscription.updateMany({
          where: { id: fresh.id, pendingStartsAt: fresh.pendingStartsAt, pendingPlanId: fresh.pendingPlanId },
          data: {
            planId: fresh.pendingPlanId,
            monthlyPrice: fresh.pendingMonthlyPrice ?? fresh.monthlyPrice,
            activeExtraBranches: fresh.pendingExtraBranches,
            activeAccountPacks: fresh.pendingAccountPacks,
            startsAt: fresh.pendingStartsAt,
            pendingPlanId: null,
            pendingMonthlyPrice: null,
            pendingStartsAt: null,
            pendingExtraBranches: 0,
            pendingAccountPacks: 0,
          },
        });
      }
      const periods = await tx.subscriptionPeriod.findMany({
        where: { subscriptionId: subscription.id, appliedAt: null, startsAt: { lte: now } },
        orderBy: { startsAt: 'asc' },
      });
      for (const period of periods) await this.applyPeriodStart(tx, period, now);
    });
  }

  /**
   * BR-11 at the first instant of a period: branches outside the keep list become INACTIVE (Tạm ngưng)
   * and accounts outside it SUSPENDED (Bị khoá), both marked as quota actions and audited. Data is kept.
   * Objects already suspended or locked manually are not touched and never reopened here.
   */
  async applyPeriodStart(
    tx: Prisma.TransactionClient,
    period: { id: string; chainId: string; branchLimit: number; accountLimit: number; keepBranchIds: Prisma.JsonValue | null; keepAccountIds: Prisma.JsonValue | null },
    now = new Date(),
  ) {
    const claimed = await tx.subscriptionPeriod.updateMany({ where: { id: period.id, appliedAt: null }, data: { appliedAt: now } });
    if (!claimed.count) return { suspendedBranchIds: [], lockedEmployeeIds: [] };
    const usage = await listCountedUsage(tx, period.chainId);
    const keepBranches = toIdList(period.keepBranchIds);
    const keepAccounts = toIdList(period.keepAccountIds);

    let keptBranches = keepBranches ? usage.branches.filter((branch) => keepBranches.includes(branch.id)) : usage.branches;
    // Safety net: a stale or missing list never leaves the chain above its limit; the oldest win.
    keptBranches = keptBranches.slice(0, Math.max(0, period.branchLimit));
    const keptBranchIds = new Set(keptBranches.map((branch) => branch.id));
    const suspended = usage.branches.filter((branch) => !keptBranchIds.has(branch.id));

    const capacity = Math.max(0, period.accountLimit - usage.owners);
    const followBranch = usage.employees.filter((employee) => suspended.some((branch) => branch.id === employee.branchId));
    const candidates = usage.employees.filter((employee) => !followBranch.includes(employee));
    let kept = keepAccounts ? candidates.filter((employee) => keepAccounts.includes(employee.id)) : candidates;
    kept = kept.slice(0, capacity);
    const keptIds = new Set(kept.map((employee) => employee.id));
    const locked = usage.employees.filter((employee) => !keptIds.has(employee.id));

    for (const branch of suspended) {
      await tx.branch.update({ where: { id: branch.id }, data: { status: BranchStatus.INACTIVE, quotaSuspendedAt: now } });
      await tx.branchAuditLog.create({
        data: {
          branchId: branch.id, actorUserId: SYSTEM_ACTOR_ID, actorRole: 'SYSTEM', action: 'BRANCH_SUSPENDED_OVER_QUOTA',
          entityType: 'BRANCH', entityId: branch.id, reason: OVER_QUOTA_REASON,
          before: { status: branch.status }, after: { status: BranchStatus.INACTIVE, periodId: period.id },
        },
      });
    }
    for (const employee of locked) {
      await tx.user.update({ where: { id: employee.user.id }, data: { status: UserStatus.SUSPENDED, quotaLockedAt: now } });
      await tx.authSession.updateMany({ where: { userId: employee.user.id, revokedAt: null }, data: { revokedAt: now } });
      await tx.passwordSetupToken.updateMany({ where: { userId: employee.user.id, usedAt: null }, data: { usedAt: now } });
      await tx.branchAuditLog.create({
        data: {
          branchId: employee.branchId, actorUserId: SYSTEM_ACTOR_ID, actorRole: 'SYSTEM', action: 'STAFF_LOCKED_OVER_QUOTA',
          entityType: 'EMPLOYEE', entityId: employee.id, reason: OVER_QUOTA_REASON,
          before: { status: employee.user.status }, after: { status: UserStatus.SUSPENDED, periodId: period.id },
        },
      });
    }
    return { suspendedBranchIds: suspended.map((branch) => branch.id), lockedEmployeeIds: locked.map((employee) => employee.id) };
  }

  /** Writes the frozen period row for a payment (idempotent per subscription + start). */
  async recordPeriod(
    tx: Prisma.TransactionClient,
    args: {
      subscriptionId: string;
      chainId: string;
      plan: Plan;
      selection: Selection;
      monthlyPrice: number;
      extraBranchPrice: number;
      accountPackPrice: number;
      startsAt: Date;
      endsAt: Date;
      invoiceId: string | null;
      source: string;
      keepBranchIds: string[] | null;
      keepAccountIds: string[] | null;
    },
  ) {
    const limits = computeLimits(args.plan, args.selection);
    const data = {
      subscriptionId: args.subscriptionId,
      chainId: args.chainId,
      invoiceId: args.invoiceId,
      planId: args.plan.id,
      planCode: args.plan.code,
      planName: args.plan.name,
      monthlyPrice: args.monthlyPrice,
      planMaxBranches: args.plan.maxBranches,
      planMaxAccounts: args.plan.maxAccounts,
      extraBranches: args.selection.extraBranches,
      extraBranchPrice: args.extraBranchPrice,
      extraBranchAccounts: args.plan.extraBranchAccounts,
      accountPacks: args.selection.accountPacks,
      accountPackPrice: args.accountPackPrice,
      branchLimit: limits.branchLimit,
      accountLimit: limits.accountLimit,
      brandingEnabled: args.plan.brandingEnabled,
      multiBranchComparisonEnabled: args.plan.multiBranchComparisonEnabled,
      startsAt: args.startsAt,
      endsAt: args.endsAt,
      source: args.source,
      keepBranchIds: args.keepBranchIds ?? Prisma.DbNull,
      keepAccountIds: args.keepAccountIds ?? Prisma.DbNull,
    };
    return tx.subscriptionPeriod.upsert({
      where: { subscriptionId_startsAt: { subscriptionId: args.subscriptionId, startsAt: args.startsAt } },
      create: data,
      update: {},
    });
  }

  /**
   * One way to turn a confirmed payment into a period, shared by the PayOS webhook, "Kiểm tra lại",
   * the reconciliation worker and Admin's manual confirmation (25.6). Caller holds the checkout lock.
   */
  async applyPayment(
    tx: Prisma.TransactionClient,
    args: {
      subscription: Prisma.BusinessSubscriptionGetPayload<{ include: { plan: true } }>;
      planId: string;
      invoice: InvoiceWithLines | null;
      isTrial: boolean;
      now: Date;
      source: string;
    },
  ) {
    const { subscription, invoice, isTrial, now } = args;
    const plan = (await tx.servicePlan.findUniqueOrThrow({ where: { id: args.planId } })) as Plan;
    const periodStart = isTrial ? now : subscription.expiresAt > now ? subscription.expiresAt : now;
    // BR-70: renewing after expiry starts from the payment, even if the invoice was issued earlier.
    const periodEnd = isTrial
      ? (invoice?.periodEndsAt ?? addSubscriptionMonth(subscription.expiresAt))
      : invoice && invoice.periodStartsAt.getTime() === periodStart.getTime()
        ? invoice.periodEndsAt
        : addSubscriptionMonth(periodStart);
    const line = (kind: string) => invoice?.lines.find((item) => item.kind === kind);
    const selection = { extraBranches: line('EXTRA_BRANCH')?.quantity ?? 0, accountPacks: line('ACCOUNT_PACK')?.quantity ?? 0 };
    const monthlyPrice = line('PLAN')?.unitPrice ?? toVnd(plan.monthlyPrice);
    const early = !isTrial && periodStart > now;
    await tx.businessSubscription.update({
      where: { id: subscription.id },
      data: {
        planId: early ? subscription.planId : plan.id,
        monthlyPrice: early ? subscription.monthlyPrice : monthlyPrice,
        status: BusinessSubscriptionStatus.ACTIVE,
        startsAt: early ? subscription.startsAt : periodStart,
        expiresAt: periodEnd,
        trialConvertedAt: isTrial ? now : subscription.trialConvertedAt,
        nextPlanId: null,
        nextExtraBranches: null,
        nextAccountPacks: null,
        nextKeepBranchIds: Prisma.DbNull,
        nextKeepAccountIds: Prisma.DbNull,
        nextRegisteredByRole: null,
        nextRegisteredAt: null,
        activeExtraBranches: early ? subscription.activeExtraBranches : selection.extraBranches,
        activeAccountPacks: early ? subscription.activeAccountPacks : selection.accountPacks,
        pendingPlanId: early ? plan.id : null,
        pendingMonthlyPrice: early ? monthlyPrice : null,
        pendingExtraBranches: early ? selection.extraBranches : 0,
        pendingAccountPacks: early ? selection.accountPacks : 0,
        pendingStartsAt: early ? periodStart : null,
      },
    });
    const period = await this.recordPeriod(tx, {
      subscriptionId: subscription.id,
      chainId: subscription.chainId,
      plan,
      selection,
      monthlyPrice,
      extraBranchPrice: line('EXTRA_BRANCH')?.unitPrice ?? plan.extraBranchPrice,
      accountPackPrice: line('ACCOUNT_PACK')?.unitPrice ?? plan.extraAccountPackPrice,
      startsAt: periodStart,
      endsAt: periodEnd,
      invoiceId: invoice?.id ?? null,
      source: args.source,
      keepBranchIds: isTrial ? null : toIdList(subscription.nextKeepBranchIds),
      keepAccountIds: isTrial ? null : toIdList(subscription.nextKeepAccountIds),
    });
    // A period starting now (late payment, trial conversion) applies at once; an early one waits.
    if (!early) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`quota:${subscription.chainId}`}))`;
      await this.applyPeriodStart(tx, period, now);
    }
    return { periodStart, periodEnd, early, period };
  }

  // ---------------------------------------------------------------- next-period resolution

  private async catalog(client: Pick<Prisma.TransactionClient, 'servicePlan'> = this.prisma): Promise<Plan[]> {
    return (await client.servicePlan.findMany({ where: { isActive: true } })) as Plan[];
  }

  /** The period the next registration builds on: the paid upcoming one if any, else the current. */
  private base(sub: SubscriptionWithPlans) {
    return sub.pendingPlanId && sub.pendingPlan
      ? { plan: sub.pendingPlan as Plan, selection: { extraBranches: sub.pendingExtraBranches, accountPacks: sub.pendingAccountPacks }, startsAt: sub.pendingStartsAt }
      : { plan: sub.plan as Plan, selection: { extraBranches: sub.activeExtraBranches, accountPacks: sub.activeAccountPacks }, startsAt: sub.startsAt };
  }

  private resolveNext(sub: SubscriptionWithPlans, catalog: Plan[], draft?: NextPeriodInput) {
    const base = this.base(sub);
    const registeredPlan = (sub.nextPlan as Plan | null) ?? base.plan;
    const plan = draft?.planId ? catalog.find((item) => item.id === draft.planId) : registeredPlan;
    if (!plan) throw new BadRequestException('Select an active paid plan');
    const registered: Selection = {
      extraBranches: sub.nextExtraBranches ?? (sub.nextPlanId && registeredPlan.id !== base.plan.id && registeredPlan.maxBranches >= base.plan.maxBranches + base.selection.extraBranches ? 0 : base.selection.extraBranches),
      accountPacks: sub.nextAccountPacks ?? base.selection.accountPacks,
    };
    let selection = registered;
    let warnings: string[] = [];
    if (draft?.planId && draft.planId !== registeredPlan.id && draft.extraBranches === undefined) {
      const carried = carryOverAddons(registeredPlan, { ...registered, accountPacks: draft.accountPacks ?? registered.accountPacks }, plan, catalog);
      selection = carried.selection;
      warnings = carried.warnings;
    } else if (draft) {
      selection = { extraBranches: draft.extraBranches ?? registered.extraBranches, accountPacks: draft.accountPacks ?? registered.accountPacks };
    }
    return { plan, selection, warnings, base };
  }

  private nextStart(sub: { expiresAt: Date }) {
    const now = new Date();
    return sub.expiresAt > now ? sub.expiresAt : now;
  }

  private async load(chainId: string, client: Pick<Prisma.TransactionClient, 'businessSubscription'> = this.prisma) {
    const sub = await client.businessSubscription.findUnique({ where: { chainId }, include: { plan: true, nextPlan: true, pendingPlan: true } });
    if (!sub) throw new NotFoundException('Business subscription not found');
    return sub;
  }

  /**
   * BR-11: what must be dropped for a next-period limit. `requiredRemoval` is 0 when everything fits.
   * Employees of a branch that will be suspended follow their branch and are locked with it.
   */
  private async keepRequirement(
    client: Prisma.TransactionClient | PrismaService,
    chainId: string,
    limits: { branchLimit: number; accountLimit: number },
    keepBranchIds: string[] | null,
  ) {
    const usage = await listCountedUsage(client, chainId);
    const keptBranchIds = keepBranchIds ? new Set(keepBranchIds) : new Set(usage.branches.map((branch) => branch.id));
    const followers = usage.employees.filter((employee) => usage.branches.some((branch) => branch.id === employee.branchId && !keptBranchIds.has(branch.id)));
    const candidates = usage.employees.filter((employee) => !followers.includes(employee));
    const capacity = Math.max(0, limits.accountLimit - usage.owners);
    return {
      usage,
      followers,
      candidates,
      capacity,
      branches: { limit: limits.branchLimit, used: usage.branches.length, mustRemove: Math.max(0, usage.branches.length - limits.branchLimit) },
      accounts: {
        limit: limits.accountLimit,
        used: usage.owners + usage.employees.length,
        owners: usage.owners,
        lockedWithBranches: followers.length,
        mustRemove: Math.max(0, candidates.length - capacity),
      },
    };
  }

  // ---------------------------------------------------------------- preview

  /** Next-period invoice preview; with `draft`, a dry run of a registration that is not saved. */
  async preview(chainId: string, draft?: NextPeriodInput) {
    await this.activateDue(chainId);
    const sub = await this.load(chainId);
    const catalog = await this.catalog();
    const { plan, selection, warnings, base } = this.resolveNext(sub, catalog, draft);
    const violation = isPaidPlan(plan) ? addonViolation(plan, selection, catalog) : { error: 'ADDON_NOT_SOLD' as const, message: 'Select an active paid plan' };
    const lines = invoiceLines(plan, selection);
    const startsAt = this.nextStart(sub);
    const limits = computeLimits(plan, selection);
    const keepBranchIds = draft ? (draft.keepBranchIds ?? null) : toIdList(sub.nextKeepBranchIds);
    const keepAccountIds = draft ? (draft.keepAccountIds ?? null) : toIdList(sub.nextKeepAccountIds);
    const requirement = await this.keepRequirement(this.prisma, chainId, limits, keepBranchIds);
    const usage = await countUsage(this.prisma, chainId);
    return {
      plan,
      extraBranches: selection.extraBranches,
      accountPacks: selection.accountPacks,
      branchLimit: limits.branchLimit,
      accountLimit: limits.accountLimit,
      startsAt,
      endsAt: addSubscriptionMonth(startsAt),
      lines,
      total: lines.reduce((sum, item) => sum + item.amount, 0),
      currentPeriodEndsAt: sub.pendingStartsAt ?? sub.expiresAt,
      paidUpcoming: !!sub.pendingStartsAt,
      upcomingPaid: sub.pendingStartsAt && sub.pendingPlan
        ? { plan: sub.pendingPlan, extraBranches: sub.pendingExtraBranches, accountPacks: sub.pendingAccountPacks, startsAt: sub.pendingStartsAt, endsAt: sub.expiresAt, ...computeLimits(sub.pendingPlan as Plan, { extraBranches: sub.pendingExtraBranches, accountPacks: sub.pendingAccountPacks }) }
        : null,
      registered: sub.nextPlanId !== null || sub.nextExtraBranches !== null || sub.nextAccountPacks !== null,
      registeredByRole: sub.nextRegisteredByRole,
      registeredAt: sub.nextRegisteredAt,
      basePlanId: base.plan.id,
      keepBranchIds,
      keepAccountIds,
      keepRequired: { branches: requirement.branches, accounts: requirement.accounts },
      usage: { branches: usage.branches, accounts: usage.accounts, owners: usage.owners, employees: usage.employees, pendingInvitations: usage.pendingInvitations },
      violation,
      warnings,
      maxSellableExtraBranches: isPaidPlan(plan) ? maxSellableExtraBranches(plan, catalog) : 0,
    };
  }

  /** Branches and accounts the Brand Manager may tick when limits shrink (BR-11, 31.4). */
  async keepCandidates(chainId: string) {
    const usage = await listCountedUsage(this.prisma, chainId);
    return {
      owners: usage.owners,
      branches: usage.branches,
      accounts: usage.employees.map((employee) => ({
        id: employee.id,
        userId: employee.user.id,
        name: `${employee.firstName} ${employee.lastName}`.trim(),
        email: employee.user.email,
        role: employee.user.role.code,
        status: employee.user.status,
        invitationState: employee.user.staffInvitationState,
        branchId: employee.branchId,
        branchName: employee.branch.name,
      })),
    };
  }

  // ---------------------------------------------------------------- registration

  async putNextPlan(chainId: string, planId: string, keep: Pick<NextPeriodInput, 'keepBranchIds' | 'keepAccountIds'> = {}, actor?: RegistrationActor) {
    return this.register(chainId, { planId, ...keep }, actor);
  }

  async putNextAddons(chainId: string, extraBranches: number, accountPacks: number, keep: Pick<NextPeriodInput, 'keepBranchIds' | 'keepAccountIds'> = {}, actor?: RegistrationActor) {
    return this.register(chainId, { extraBranches, accountPacks, ...keep }, actor);
  }

  /** Cancels the registration: the next period repeats the base plan and its add-ons. */
  async clearNextPlan(chainId: string, keep: Pick<NextPeriodInput, 'keepBranchIds' | 'keepAccountIds'> = {}, actor?: RegistrationActor) {
    return this.register(chainId, { ...keep }, actor, true);
  }

  /**
   * BR-90/91/92/11 registration for the next unpaid period. Validates against the live catalog,
   * requires a keep list when the new limit is below current usage, then invalidates any unpaid
   * next-period invoice and PayOS link so it is re-issued from the new registration.
   */
  async register(chainId: string, input: NextPeriodInput, actor?: RegistrationActor, clear = false) {
    if (actor && actor.role !== 'BRAND_MANAGER' && (actor.note?.trim().length ?? 0) < 3) {
      throw new BadRequestException('A support note of at least 3 characters is required');
    }
    const sub = await this.load(chainId);
    this.assertCanSchedule(sub);
    const catalog = await this.catalog();
    const base = this.base(sub);
    const resolved = clear ? { plan: base.plan, selection: base.selection, warnings: [] as string[] } : this.resolveNext(sub, catalog, input);
    const { plan, selection } = resolved;
    if (!plan.isActive || !isPaidPlan(plan)) throw new BadRequestException('Select an active paid plan');
    const violation = addonViolation(plan, selection, catalog);
    if (violation) {
      if (violation.error === 'INVALID_ADDON_QUANTITY') throw new BadRequestException({ statusCode: 400, ...violation });
      throw new ConflictException({ statusCode: 409, ...violation });
    }
    const limits = computeLimits(plan, selection);
    await this.cancelPendingCheckout(chainId);
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`subscription:${chainId}`}))`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`quota:${chainId}`}))`;
      const keep = await this.validateKeepLists(tx, chainId, limits, input, this.nextStart(sub));
      const sameAsBase = plan.id === base.plan.id && selection.extraBranches === base.selection.extraBranches && selection.accountPacks === base.selection.accountPacks;
      await tx.businessSubscription.update({
        where: { id: sub.id },
        data: {
          nextPlanId: plan.id === base.plan.id ? null : plan.id,
          nextExtraBranches: sameAsBase ? null : selection.extraBranches,
          nextAccountPacks: sameAsBase ? null : selection.accountPacks,
          nextKeepBranchIds: keep.keepBranchIds ?? Prisma.DbNull,
          nextKeepAccountIds: keep.keepAccountIds ?? Prisma.DbNull,
          nextRegisteredByRole: sameAsBase ? null : (actor?.role ?? 'BRAND_MANAGER'),
          nextRegisteredAt: sameAsBase ? null : new Date(),
        },
      });
      await this.invalidateUnpaid(tx, chainId);
      if (actor && actor.role !== 'BRAND_MANAGER') {
        await tx.platformSupportAction.create({
          data: {
            actorUserId: actor.userId, chainId, action: clear ? 'CLEAR_NEXT_PERIOD' : 'SCHEDULE_NEXT_PERIOD', note: actor.note!.trim(),
            details: { planId: plan.id, planCode: plan.code, ...selection, keepBranchIds: keep.keepBranchIds, keepAccountIds: keep.keepAccountIds, role: actor.role },
          },
        });
      }
      await this.queueNotice(tx, chainId, null, {
        subject: 'Smart F&B: đã lưu đăng ký kỳ tới',
        heading: actor && actor.role !== 'BRAND_MANAGER' ? 'Nền tảng đã đổi đăng ký kỳ tới theo yêu cầu của bạn' : 'Đăng ký kỳ tới đã được lưu',
        paragraphs: [
          `Kỳ tới: gói ${plan.name}, ${limits.branchLimit} chi nhánh, ${limits.accountLimit} tài khoản, ${invoiceLines(plan, selection).reduce((sum, item) => sum + item.amount, 0).toLocaleString('vi-VN')}đ/tháng.`,
          `Áp dụng từ ${this.nextStart(sub).toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}; kỳ hiện tại giữ nguyên gói và hạn mức.`,
        ],
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    const preview = await this.preview(chainId);
    if (preview.currentPeriodEndsAt.getTime() - Date.now() <= 7 * 86_400_000 && !preview.paidUpcoming) {
      await this.getOrCreateInvoice(chainId).catch((error) => this.logger.warn(`Invoice re-issue deferred for ${chainId}: ${String(error)}`));
    }
    return { ...preview, warnings: resolved.warnings };
  }

  /** Throws the BR-11 error body when a keep list is required, invalid, or too long. */
  private async validateKeepLists(
    tx: Prisma.TransactionClient,
    chainId: string,
    limits: { branchLimit: number; accountLimit: number },
    input: Pick<NextPeriodInput, 'keepBranchIds' | 'keepAccountIds'>,
    effectiveFrom: Date,
  ) {
    const requested = input.keepBranchIds ? [...input.keepBranchIds] : null;
    const usage = await listCountedUsage(tx, chainId);
    const fail = (error: string, message: string, extra: Record<string, unknown> = {}) => {
      throw new ConflictException({ statusCode: 409, error, message, effectiveFrom, ...extra });
    };
    let keepBranchIds: string[] | null = null;
    if (usage.branches.length > limits.branchLimit) {
      if (!requested) {
        fail('KEEP_SELECTION_REQUIRED', `Kỳ tới chỉ giữ được ${limits.branchLimit} chi nhánh; hãy chọn chi nhánh được giữ.`, {
          resource: 'branches', limit: limits.branchLimit, used: usage.branches.length, mustRemove: usage.branches.length - limits.branchLimit,
        });
      }
      if (new Set(requested).size !== requested!.length) fail('KEEP_LIST_DUPLICATE', 'Danh sách chi nhánh được giữ bị trùng.');
      const valid = new Set(usage.branches.map((branch) => branch.id));
      const foreign = requested!.filter((id) => !valid.has(id));
      if (foreign.length) fail('KEEP_LIST_INVALID', 'Có chi nhánh không thuộc chuỗi hoặc không đang hoạt động.', { invalidIds: foreign });
      if (requested!.length > limits.branchLimit) {
        fail('KEEP_LIST_TOO_LONG', `Chỉ được giữ tối đa ${limits.branchLimit} chi nhánh.`, { resource: 'branches', limit: limits.branchLimit, selected: requested!.length, mustRemove: requested!.length - limits.branchLimit });
      }
      keepBranchIds = requested;
    }
    const requirement = await this.keepRequirement(tx, chainId, limits, keepBranchIds);
    let keepAccountIds: string[] | null = null;
    if (requirement.accounts.mustRemove > 0) {
      const accounts = input.keepAccountIds ? [...input.keepAccountIds] : null;
      if (!accounts) {
        fail('KEEP_SELECTION_REQUIRED', `Kỳ tới chỉ giữ được ${limits.accountLimit} tài khoản (gồm ${requirement.usage.owners} Brand Manager); hãy chọn tài khoản được giữ.`, {
          resource: 'accounts', limit: limits.accountLimit, used: requirement.accounts.used, mustRemove: requirement.accounts.mustRemove, lockedWithBranches: requirement.followers.length,
        });
      }
      if (new Set(accounts).size !== accounts!.length) fail('KEEP_LIST_DUPLICATE', 'Danh sách tài khoản được giữ bị trùng.');
      const candidateIds = new Set(requirement.candidates.map((employee) => employee.id));
      const followerIds = new Set(requirement.followers.map((employee) => employee.id));
      const inDroppedBranch = accounts!.filter((id) => followerIds.has(id));
      if (inDroppedBranch.length) fail('ACCOUNT_BRANCH_NOT_KEPT', 'Tài khoản thuộc chi nhánh không được giữ sẽ bị khoá cùng chi nhánh.', { invalidIds: inDroppedBranch });
      const foreign = accounts!.filter((id) => !candidateIds.has(id));
      if (foreign.length) fail('KEEP_LIST_INVALID', 'Có tài khoản không thuộc chuỗi hoặc đã bị khoá.', { invalidIds: foreign });
      if (accounts!.length > requirement.capacity) {
        fail('KEEP_LIST_TOO_LONG', `Chỉ được giữ tối đa ${requirement.capacity} tài khoản nhân viên (Brand Manager luôn được giữ).`, { resource: 'accounts', limit: limits.accountLimit, selected: accounts!.length, mustRemove: accounts!.length - requirement.capacity });
      }
      keepAccountIds = accounts;
    }
    return { keepBranchIds, keepAccountIds };
  }

  // ---------------------------------------------------------------- invoices

  async getOrCreateInvoice(chainId: string) {
    const preview = await this.preview(chainId);
    if (preview.paidUpcoming) throw new ConflictException('Upcoming period has already been paid');
    if (preview.currentPeriodEndsAt.getTime() - Date.now() > 7 * 86_400_000) throw new ConflictException('Invoice opens 7 days before expiry');
    if (preview.lines.some((line) => !Number.isSafeInteger(line.amount))) throw new BadRequestException('Plan price must be whole VND');
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
    if (sub.plan.code !== 'TRIAL' && sub.status !== BusinessSubscriptionStatus.SUSPENDED && !sub.pendingStartsAt && sub.expiresAt.getTime() - Date.now() <= 7 * 86_400_000) {
      await this.getOrCreateInvoice(chainId).catch((error) => this.logger.warn(`Invoice not issued for ${chainId}: ${String(error)}`));
    }
    return this.prisma.subscriptionInvoice.findMany({ where: { chainId }, include: { lines: true }, orderBy: { createdAt: 'desc' }, take: 24 });
  }

  // ---------------------------------------------------------------- emails

  /** Queues a Brand Manager notice; with a dedupe key a repeated job run never sends it twice. */
  async queueNotice(
    client: Pick<Prisma.TransactionClient, 'ownerChainAssignment' | 'emailOutbox'>,
    chainId: string,
    dedupeKey: string | null,
    notice: { subject: string; heading: string; paragraphs: string[]; lines?: Array<{ description: string; quantity: number; amount: number }>; total?: number },
  ) {
    const owners = await client.ownerChainAssignment.findMany({
      where: { chainId, owner: { deletedAt: null, user: { deletedAt: null, status: UserStatus.ACTIVE } } },
      select: { owner: { select: { user: { select: { email: true } } } } },
    });
    const ids: string[] = [];
    for (const [index, assignment] of owners.entries()) {
      const key = dedupeKey ? `${dedupeKey}:${index}`.slice(0, 150) : null;
      if (key && (await client.emailOutbox.findUnique({ where: { dedupeKey: key }, select: { id: true } }))) continue;
      const row = await client.emailOutbox.create({
        data: { dedupeKey: key, recipient: assignment.owner.user.email, subject: notice.subject, template: 'SUBSCRIPTION_NOTICE', payload: notice },
        select: { id: true },
      });
      ids.push(row.id);
    }
    return ids;
  }

  // ---------------------------------------------------------------- guards

  private assertCanSchedule(sub: { status: BusinessSubscriptionStatus; plan: { code: string }; trialStartedAt?: Date | null; trialConvertedAt?: Date | null }) {
    if (sub.plan.code === 'TRIAL' || sub.status === BusinessSubscriptionStatus.SUSPENDED) throw new ConflictException('Cannot schedule during trial or suspension');
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
