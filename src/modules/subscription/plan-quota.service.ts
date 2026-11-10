import { ConflictException, ForbiddenException, Injectable, Optional } from '@nestjs/common';
import { BusinessSubscriptionStatus, Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import { SubscriptionScheduleService } from './subscription-schedule.service.js';

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
} satisfies Prisma.ServicePlanSelect;

type PlanSummary = Prisma.ServicePlanGetPayload<{ select: typeof planSelect }>;

const limitFieldByResource = {
  branches: 'maxBranches',
  accounts: 'maxAccounts',
  tables: 'maxTables',
} as const satisfies Record<QuotaResource, keyof PlanSummary>;

const resourceLabel = {
  branches: 'chi nhánh',
  accounts: 'tài khoản',
  tables: 'bàn',
} as const satisfies Record<QuotaResource, string>;

/**
 * Enforces the service-plan limits an Owner runs into, and turns a rejection into
 * an upgrade suggestion instead of a bare "limit reached".
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
    const subscription = await this.prisma.businessSubscription.findUnique({
      where: { chainId },
      select: { plan: { select: planSelect } },
    });
    if (!subscription) {
      throw new ForbiddenException('The business subscription was not found');
    }
    const plan = subscription.plan;
    const enabled =
      feature === 'BRANDING' ? plan.brandingEnabled : plan.multiBranchComparisonEnabled;
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

  async getUsage(chainId: string) {
    const [branchCount, employeeCount, tableCount] = await Promise.all([
      this.prisma.branch.count({ where: { chainId, deletedAt: null } }),
      this.prisma.employee.count({
        where: { branch: { chainId }, deletedAt: null, user: { deletedAt: null } },
      }),
      this.prisma.restaurantTable.count({ where: { branch: { chainId }, deletedAt: null } }),
    ]);

    return {
      branches: branchCount,
      accounts: employeeCount,
      tables: tableCount,
    } satisfies Record<QuotaResource, number>;
  }

  /** Usage against the plan limits — what the Owner overview screen renders. */
  async getQuotaSnapshot(chainId: string) {
    const [plan, usage, sub] = await Promise.all([this.getActivePlan(chainId), this.getUsage(chainId), this.prisma.businessSubscription.findUnique({ where: { chainId } })]);
    const resources = Object.keys(limitFieldByResource) as QuotaResource[];

    return {
      plan,
      quotas: resources.map((resource) => this.toUsage(resource, usage[resource], plan, sub?.activeExtraBranches ?? 0, sub?.activeAccountPacks ?? 0)),
    };
  }

  /** Read-only subscription view. Unlike quota enforcement, expired and suspended plans remain visible. */
  async getSubscriptionSnapshot(chainId: string): Promise<SubscriptionSnapshot | null> {
    await this.schedule?.activateDue(chainId);
    const subscription = await this.prisma.businessSubscription.findUnique({
      where: { chainId },
      select: { status: true, expiresAt: true, pendingStartsAt: true, activeExtraBranches: true, activeAccountPacks: true, nextExtraBranches: true, nextAccountPacks: true, plan: { select: planSelect }, nextPlan: { select: planSelect } },
    });
    if (!subscription) return null;

    const usage = await this.getUsage(chainId);
    const resources = Object.keys(limitFieldByResource) as QuotaResource[];
    const status =
      subscription.status === BusinessSubscriptionStatus.ACTIVE &&
      (subscription.pendingStartsAt ?? subscription.expiresAt) <= new Date()
        ? BusinessSubscriptionStatus.EXPIRED
        : subscription.status;
    return {
      status,
      expiresAt: subscription.pendingStartsAt ?? subscription.expiresAt,
      plan: subscription.plan,
      nextPlan: subscription.nextPlan,
      activeExtraBranches: subscription.activeExtraBranches,
      activeAccountPacks: subscription.activeAccountPacks,
      nextExtraBranches: subscription.nextExtraBranches,
      nextAccountPacks: subscription.nextAccountPacks,
      pendingStartsAt: subscription.pendingStartsAt,
      quotas: resources.map((resource) =>
        this.toUsage(resource, usage[resource], subscription.plan, subscription.activeExtraBranches, subscription.activeAccountPacks),
      ),
    };
  }

  /**
   * Blocks the caller when adding one more of `resource` would exceed the plan,
   * with the plans that would unblock it attached to the 409 body.
   */
  async assertWithinQuota(chainId: string, resource: QuotaResource): Promise<void> {
    const plan = await this.getActivePlan(chainId);
    const [usage, sub] = await Promise.all([this.getUsage(chainId), this.prisma.businessSubscription.findUnique({ where: { chainId } })]);
    const quota = this.toUsage(resource, usage[resource], plan, sub?.activeExtraBranches ?? 0, sub?.activeAccountPacks ?? 0);

    if (quota.remaining > 0) {
      return;
    }

    throw new ConflictException({
      statusCode: 409,
      error: 'PLAN_LIMIT_REACHED',
      message: `Gói ${plan.name} chỉ cho phép ${quota.limit} ${resourceLabel[resource]}. Đăng ký gói hoặc mua thêm cho kỳ tới; áp dụng từ ${(sub?.pendingStartsAt ?? sub?.expiresAt)?.toISOString() ?? 'kỳ tới'}.`,
      quota,
      currentPlan: plan,
      suggestedPlans: await this.findUpgradePlans(plan, resource, quota.used + 1),
      effectiveFrom: sub?.pendingStartsAt ?? sub?.expiresAt ?? null,
      suggestedAddons: await this.findAddonSuggestion(plan, sub?.activeExtraBranches ?? 0, sub?.activeAccountPacks ?? 0, resource),
    });
  }

  /** Active plans that fit the requested amount, cheapest first. */
  private async findUpgradePlans(
    currentPlan: PlanSummary,
    resource: QuotaResource,
    requiredAmount: number,
  ) {
    const limitField = limitFieldByResource[resource];
    const plans = await this.prisma.servicePlan.findMany({
      where: {
        isActive: true,
        id: { not: currentPlan.id },
        code: { not: 'TRIAL' },
        [limitField]: { gte: requiredAmount },
      },
      select: planSelect,
      orderBy: [{ monthlyPrice: 'asc' }, { [limitField]: 'asc' }],
      take: 3,
    });

    return plans.map((plan) => ({
      ...plan,
      priceDifference: plan.monthlyPrice.minus(currentPlan.monthlyPrice),
    }));
  }

  private async findAddonSuggestion(plan: PlanSummary, currentBranches: number, currentPacks: number, resource: QuotaResource) {
    if (plan.code === 'TRIAL') return null;
    if (resource === 'accounts') return currentPacks < 4 ? { accountPacks: currentPacks + 1, effectiveFrom: 'NEXT_PERIOD' } : null;
    if (resource !== 'branches' || !plan.extraBranchEnabled || plan.extraBranchPrice <= 0 || plan.maxBranches + currentBranches >= 10) return null;
    const desired = currentBranches + 1;
    const betterPlan = await this.prisma.servicePlan.findFirst({ where: { isActive: true, code: { not: 'TRIAL' }, maxBranches: { gte: plan.maxBranches + desired } }, orderBy: { monthlyPrice: 'asc' } });
    return betterPlan && Number(plan.monthlyPrice) + desired * plan.extraBranchPrice >= Number(betterPlan.monthlyPrice)
      ? null
      : { extraBranches: desired, effectiveFrom: 'NEXT_PERIOD' };
  }

  private toUsage(resource: QuotaResource, used: number, plan: PlanSummary, extraBranches = 0, accountPacks = 0): QuotaUsage {
    const limit = plan[limitFieldByResource[resource]] + (resource === 'branches' ? extraBranches : resource === 'accounts' ? extraBranches * (plan.extraBranchAccounts ?? 8) + accountPacks * 5 : 0);
    return { resource, used, limit, remaining: Math.max(limit - used, 0) };
  }
}
