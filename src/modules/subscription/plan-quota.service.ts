import { ConflictException, ForbiddenException, Injectable, Optional } from '@nestjs/common';
import { BusinessSubscriptionStatus, Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import { SubscriptionScheduleService } from './subscription-schedule.service.js';
import {
  addonViolation,
  cheapestPlanWithBranches,
  computeLimits,
  isPaidPlan,
  MAX_ACCOUNT_PACKS,
  MAX_TOTAL_BRANCHES,
  type PlanPricing,
  toVnd,
} from './subscription-limits.js';
import { countUsage, effectiveLimits, type EffectiveLimits, type UsageCounts } from './subscription-usage.js';

export type QuotaResource = 'branches' | 'accounts' | 'tables';
export type PlanFeature = 'BRANDING' | 'MULTI_BRANCH_COMPARISON';

export interface QuotaUsage {
  resource: QuotaResource;
  used: number;
  limit: number;
  remaining: number;
}

export interface SubscriptionSnapshot {
  status: BusinessSubscriptionStatus;
  expiresAt: Date;
  plan: PlanSummary;
  nextPlan: PlanSummary | null;
  activeExtraBranches: number;
  activeAccountPacks: number;
  nextExtraBranches: number | null;
  nextAccountPacks: number | null;
  pendingStartsAt: Date | null;
  quotas: QuotaUsage[];
  effective: {
    source: EffectiveLimits['source'];
    planCode: string;
    planName: string;
    extraBranches: number;
    accountPacks: number;
    branchLimit: number;
    accountLimit: number;
    brandingEnabled: boolean;
    multiBranchComparisonEnabled: boolean;
    periodStartsAt: Date;
    periodEndsAt: Date;
  };
  accountUsage: { owners: number; employees: number; pendingInvitations: number };
  nextRegistration: { registeredByRole: string | null; registeredAt: Date | null } | null;
}

const planSelect = {
  id: true,
  code: true,
  name: true,
  description: true,
  monthlyPrice: true,
  maxBranches: true,
  maxAccounts: true,
  extraBranchPrice: true,
  extraBranchAccounts: true,
  extraAccountPackPrice: true,
  extraBranchEnabled: true,
  maxTables: true,
  brandingEnabled: true,
  multiBranchComparisonEnabled: true,
  isActive: true,
} satisfies Prisma.ServicePlanSelect;

type PlanSummary = Prisma.ServicePlanGetPayload<{ select: typeof planSelect }>;

const resourceLabel = {
  branches: 'chi nhánh',
  accounts: 'tài khoản',
  tables: 'bàn',
} as const satisfies Record<QuotaResource, string>;

type QuotaClient = Prisma.TransactionClient | PrismaService;

const toIdList = (value: Prisma.JsonValue | null | undefined): string[] | null =>
  Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : null;

/**
 * Single source of the quota rule for the backend (13.1, 31.6):
 *   branch limit  = plan branches in force + extra branches in force;
 *   account limit = plan accounts in force + 8 × extra branches + 5 × account packs in force;
 *   used accounts = Brand Managers + unlocked staff, pending invitations included.
 * "In force" is the paid period containing now; paying early never raises it before that period.
 */
@Injectable()
export class PlanQuotaService {
  constructor(private readonly prisma: PrismaService, @Optional() private readonly schedule?: SubscriptionScheduleService) {}

  /** Throws unless the chain has a subscription that is ACTIVE and not expired. */
  async getActivePlan(chainId: string): Promise<PlanSummary> {
    await this.schedule?.activateDue(chainId);
    const subscription = await this.prisma.businessSubscription.findFirst({
      where: {
        chainId,
        status: BusinessSubscriptionStatus.ACTIVE,
        expiresAt: { gt: new Date() },
      },
      select: { plan: { select: planSelect } },
    });

    if (!subscription) {
      throw new ForbiddenException('The business subscription is not active');
    }

    return subscription.plan;
  }

  async assertFeatureEnabled(chainId: string, feature: PlanFeature): Promise<void> {
    await this.schedule?.activateDue(chainId);
    const limits = await effectiveLimits(this.prisma, chainId);
    if (!limits) {
      throw new ForbiddenException('The business subscription was not found');
    }
    const enabled = feature === 'BRANDING' ? limits.brandingEnabled : limits.multiBranchComparisonEnabled;
    if (enabled) return;
    throw new ForbiddenException({
      statusCode: 403,
      error: 'PLAN_FEATURE_NOT_ENABLED',
      feature,
      message:
        feature === 'BRANDING'
          ? 'Gói hiện tại không hỗ trợ nhận diện thương hiệu.'
          : 'Gói hiện tại không hỗ trợ so sánh nhiều chi nhánh.',
    });
  }

  async getUsage(chainId: string, client: QuotaClient = this.prisma): Promise<Record<QuotaResource, number> & UsageCounts> {
    return countUsage(client, chainId);
  }

  /** Usage against the limits in force — Owner overview, Admin/Staff business screens. */
  async getQuotaSnapshot(chainId: string) {
    const [plan, usage, limits] = await Promise.all([this.getActivePlan(chainId), this.getUsage(chainId), effectiveLimits(this.prisma, chainId)]);
    return { plan, quotas: this.quotas(usage, limits!), effective: limits };
  }

  /** Read-only subscription view. Unlike quota enforcement, expired and suspended plans remain visible. */
  async getSubscriptionSnapshot(chainId: string): Promise<SubscriptionSnapshot | null> {
    await this.schedule?.activateDue(chainId);
    const subscription = await this.prisma.businessSubscription.findUnique({
      where: { chainId },
      select: {
        status: true, expiresAt: true, pendingStartsAt: true, activeExtraBranches: true, activeAccountPacks: true,
        nextExtraBranches: true, nextAccountPacks: true, nextPlanId: true, nextRegisteredByRole: true, nextRegisteredAt: true,
        plan: { select: planSelect }, nextPlan: { select: planSelect },
      },
    });
    if (!subscription) return null;

    const [usage, limits] = await Promise.all([this.getUsage(chainId), effectiveLimits(this.prisma, chainId)]);
    const status =
      subscription.status === BusinessSubscriptionStatus.ACTIVE &&
      (subscription.pendingStartsAt ?? subscription.expiresAt) <= new Date()
        ? BusinessSubscriptionStatus.EXPIRED
        : subscription.status;
    const registered = subscription.nextPlanId !== null || subscription.nextExtraBranches !== null || subscription.nextAccountPacks !== null;
    return {
      status,
      expiresAt: subscription.pendingStartsAt ?? subscription.expiresAt,
      plan: subscription.plan,
      nextPlan: subscription.nextPlan,
      activeExtraBranches: limits!.extraBranches,
      activeAccountPacks: limits!.accountPacks,
      nextExtraBranches: subscription.nextExtraBranches,
      nextAccountPacks: subscription.nextAccountPacks,
      pendingStartsAt: subscription.pendingStartsAt,
      quotas: this.quotas(usage, limits!),
      effective: {
        source: limits!.source,
        planCode: limits!.planCode,
        planName: limits!.planName,
        extraBranches: limits!.extraBranches,
        accountPacks: limits!.accountPacks,
        branchLimit: limits!.branchLimit,
        accountLimit: limits!.accountLimit,
        brandingEnabled: limits!.brandingEnabled,
        multiBranchComparisonEnabled: limits!.multiBranchComparisonEnabled,
        periodStartsAt: limits!.periodStartsAt,
        periodEndsAt: limits!.periodEndsAt,
      },
      accountUsage: { owners: usage.owners, employees: usage.employees, pendingInvitations: usage.pendingInvitations },
      nextRegistration: registered ? { registeredByRole: subscription.nextRegisteredByRole, registeredAt: subscription.nextRegisteredAt } : null,
    };
  }

  /**
   * Non-transactional check kept for callers that only need a pre-flight answer. Writers must use
   * {@link assertCanAdd} inside their transaction so concurrent requests cannot overshoot.
   */
  async assertWithinQuota(chainId: string, resource: QuotaResource): Promise<void> {
    await this.getActivePlan(chainId);
    await this.check(this.prisma, chainId, resource, 1);
  }

  /**
   * Transactional quota gate for every writer (create branch, invite, reopen branch/account).
   * Serialises the chain with an advisory lock, recounts, and enforces the BR-11 keep lists already
   * registered for the next period. Returns a hook that records the new id in those keep lists.
   */
  async assertCanAdd(tx: Prisma.TransactionClient, chainId: string, resource: 'branches' | 'accounts', amount = 1) {
    // No activateDue here: it opens its own transaction and could wait on rows this one holds.
    // Limits are read by date from the period rows, so they are already correct at a period start.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`quota:${chainId}`}))`;
    await this.check(tx, chainId, resource, amount);
    return this.reserveNextPeriodSlot(tx, chainId, resource, amount);
  }

  private async check(client: QuotaClient, chainId: string, resource: QuotaResource, amount: number) {
    const [usage, limits] = await Promise.all([this.getUsage(chainId, client), effectiveLimits(client, chainId)]);
    if (!limits) throw new ForbiddenException('The business subscription is not active');
    const quota = this.quotas(usage, limits).find((item) => item.resource === resource)!;
    if (quota.used + amount <= quota.limit) return;
    const subscription = await client.businessSubscription.findUnique({
      where: { chainId },
      select: { expiresAt: true, pendingStartsAt: true, plan: { select: planSelect } },
    });
    const effectiveFrom = subscription ? (subscription.expiresAt > new Date() ? limits.periodEndsAt : new Date()) : null;
    const catalog = (await client.servicePlan.findMany({ where: { isActive: true }, select: planSelect })) as PlanSummary[];
    const current = catalog.find((plan) => plan.id === limits.planId) ?? subscription?.plan ?? null;
    throw new ConflictException({
      statusCode: 409,
      error: 'PLAN_LIMIT_REACHED',
      message: `Gói ${limits.planName} hiện cho phép ${quota.limit} ${resourceLabel[resource]} (đang dùng ${quota.used}${resource === 'accounts' ? `, gồm ${usage.owners} Brand Manager và ${usage.pendingInvitations} lời mời đang chờ` : ''}). Nâng gói hoặc mua thêm cho kỳ tới; hạn mức mới áp dụng từ ${effectiveFrom ? effectiveFrom.toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }) : 'kỳ tới'}.`,
      resource,
      quota,
      limit: quota.limit,
      used: quota.used,
      effectiveFrom,
      currentPlan: current,
      suggestedPlans: this.upgradePlans(catalog, current, resource, quota.used + amount),
      suggestedAddons: current ? this.addonSuggestion(current as PlanPricing, catalog as PlanPricing[], limits, resource, quota.used + amount) : null,
    });
  }

  /**
   * BR-11 (31.5): after a keep list was chosen, adding a branch or account that would not fit the next
   * period requires choosing again. When the list still has room the new id is appended to it.
   */
  private async reserveNextPeriodSlot(tx: Prisma.TransactionClient, chainId: string, resource: 'branches' | 'accounts', amount: number) {
    const subscription = await tx.businessSubscription.findUnique({
      where: { chainId },
      include: { plan: true, nextPlan: true, pendingPlan: true },
    });
    if (!subscription) return async () => undefined;
    const field = resource === 'branches' ? 'nextKeepBranchIds' : 'nextKeepAccountIds';
    const periodField = resource === 'branches' ? 'keepBranchIds' : 'keepAccountIds';
    const constraints: Array<{ kind: 'registration' | 'period'; id: string; limit: number; keep: string[] | null }> = [];
    const upcoming = await tx.subscriptionPeriod.findMany({
      where: { subscriptionId: subscription.id, appliedAt: null, startsAt: { gt: new Date() } },
    });
    for (const period of upcoming) {
      constraints.push({ kind: 'period', id: period.id, limit: resource === 'branches' ? period.branchLimit : period.accountLimit, keep: toIdList(period[periodField]) });
    }
    const registered = subscription.nextPlanId !== null || subscription.nextExtraBranches !== null || subscription.nextAccountPacks !== null;
    if (registered) {
      const base = subscription.pendingPlan ?? subscription.plan;
      const plan = (subscription.nextPlan ?? base) as PlanPricing;
      const limits = computeLimits(plan, {
        extraBranches: subscription.nextExtraBranches ?? (subscription.pendingPlan ? subscription.pendingExtraBranches : subscription.activeExtraBranches),
        accountPacks: subscription.nextAccountPacks ?? (subscription.pendingPlan ? subscription.pendingAccountPacks : subscription.activeAccountPacks),
      });
      constraints.push({ kind: 'registration', id: subscription.id, limit: resource === 'branches' ? limits.branchLimit : limits.accountLimit, keep: toIdList(subscription[field]) });
    }
    if (!constraints.length) return async () => undefined;
    const usage = await this.getUsage(chainId, tx);
    const owners = resource === 'accounts' ? usage.owners : 0;
    const used = resource === 'branches' ? usage.branches : usage.employees;
    for (const constraint of constraints) {
      const capacity = constraint.limit - owners;
      const fits = constraint.keep ? constraint.keep.length + amount <= capacity : used + amount <= capacity;
      if (!fits) {
        throw new ConflictException({
          statusCode: 409,
          error: 'NEXT_PERIOD_KEEP_SELECTION_REQUIRED',
          resource,
          limit: constraint.limit,
          message: `Kỳ tới chỉ giữ được ${constraint.limit} ${resourceLabel[resource]}. Hãy chọn lại danh sách được giữ cho kỳ tới (bỏ bớt) trước khi tạo thêm.`,
        });
      }
    }
    return async (id: string) => {
      for (const constraint of constraints) {
        if (!constraint.keep) continue;
        const keep = [...constraint.keep, id];
        if (constraint.kind === 'period') await tx.subscriptionPeriod.update({ where: { id: constraint.id }, data: { [periodField]: keep } });
        else await tx.businessSubscription.update({ where: { id: constraint.id }, data: { [field]: keep } });
      }
    };
  }

  /** Active paid plans that would fit the requested amount, cheapest first. */
  private upgradePlans(catalog: PlanSummary[], current: PlanSummary | null, resource: QuotaResource, requiredAmount: number) {
    const field = resource === 'branches' ? 'maxBranches' : resource === 'accounts' ? 'maxAccounts' : 'maxTables';
    return catalog
      .filter((plan) => plan.id !== current?.id && isPaidPlan(plan) && plan[field] >= requiredAmount)
      .sort((a, b) => toVnd(a.monthlyPrice) - toVnd(b.monthlyPrice))
      .slice(0, 3)
      .map((plan) => ({ ...plan, priceDifference: current ? plan.monthlyPrice.minus(current.monthlyPrice) : plan.monthlyPrice }));
  }

  /** A next-period add-on that would unblock the request and still passes BR-91/BR-92, if any. */
  private addonSuggestion(plan: PlanPricing, catalog: PlanPricing[], limits: EffectiveLimits, resource: QuotaResource, required: number) {
    if (!isPaidPlan(plan) || limits.planCode === 'TRIAL') return null;
    if (resource === 'accounts') {
      const accountLimit = computeLimits(plan, { extraBranches: limits.extraBranches, accountPacks: 0 }).accountLimit;
      const packs = Math.max(limits.accountPacks, Math.ceil(Math.max(0, required - accountLimit) / 5));
      if (packs > MAX_ACCOUNT_PACKS || plan.extraAccountPackPrice <= 0) return null;
      return { extraBranches: limits.extraBranches, accountPacks: packs, effectiveFrom: 'NEXT_PERIOD' };
    }
    if (resource !== 'branches') return null;
    const extraBranches = Math.max(0, required - plan.maxBranches);
    if (plan.maxBranches + extraBranches > MAX_TOTAL_BRANCHES) return null;
    if (addonViolation(plan, { extraBranches, accountPacks: limits.accountPacks }, catalog)) {
      const better = cheapestPlanWithBranches(plan, catalog, plan.maxBranches + extraBranches);
      return better ? { suggestedPlanId: better.id, suggestedPlanCode: better.code, effectiveFrom: 'NEXT_PERIOD' } : null;
    }
    return { extraBranches, accountPacks: limits.accountPacks, effectiveFrom: 'NEXT_PERIOD' };
  }

  private quotas(usage: UsageCounts, limits: EffectiveLimits): QuotaUsage[] {
    const entries: Array<[QuotaResource, number, number]> = [
      ['branches', usage.branches, limits.branchLimit],
      ['accounts', usage.accounts, limits.accountLimit],
      ['tables', usage.tables, limits.tableLimit],
    ];
    return entries.map(([resource, used, limit]) => ({ resource, used, limit, remaining: Math.max(limit - used, 0) }));
  }
}
