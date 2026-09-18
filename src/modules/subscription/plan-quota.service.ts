import { ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { BusinessSubscriptionStatus, Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';

export type QuotaResource = 'branches' | 'accounts' | 'tables';

export interface QuotaUsage {
  resource: QuotaResource;
  used: number;
  limit: number;
  remaining: number;
}

const planSelect = {
  id: true,
  code: true,
  name: true,
  description: true,
  monthlyPrice: true,
  maxBranches: true,
  maxAccounts: true,
  maxTables: true,
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
  constructor(private readonly prisma: PrismaService) {}

  /** Throws unless the chain has a subscription that is ACTIVE and not expired. */
  async getActivePlan(chainId: string): Promise<PlanSummary> {
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

  async getUsage(chainId: string) {
    const [branchCount, employeeCount, ownerCount, tableCount] = await Promise.all([
      this.prisma.branch.count({ where: { chainId, deletedAt: null } }),
      this.prisma.employee.count({
        where: { branch: { chainId }, deletedAt: null, user: { deletedAt: null } },
      }),
      this.prisma.ownerChainAssignment.count({
        where: { chainId, owner: { deletedAt: null, user: { deletedAt: null } } },
      }),
      this.prisma.restaurantTable.count({ where: { branch: { chainId }, deletedAt: null } }),
    ]);

    return {
      branches: branchCount,
      accounts: employeeCount + ownerCount,
      tables: tableCount,
    } satisfies Record<QuotaResource, number>;
  }

  /** Usage against the plan limits — what the Owner overview screen renders. */
  async getQuotaSnapshot(chainId: string) {
    const [plan, usage] = await Promise.all([this.getActivePlan(chainId), this.getUsage(chainId)]);
    const resources = Object.keys(limitFieldByResource) as QuotaResource[];

    return {
      plan,
      quotas: resources.map((resource) => this.toUsage(resource, usage[resource], plan)),
    };
  }

  /**
   * Blocks the caller when adding one more of `resource` would exceed the plan,
   * with the plans that would unblock it attached to the 409 body.
   */
  async assertWithinQuota(chainId: string, resource: QuotaResource): Promise<void> {
    const plan = await this.getActivePlan(chainId);
    const usage = await this.getUsage(chainId);
    const quota = this.toUsage(resource, usage[resource], plan);

    if (quota.remaining > 0) {
      return;
    }

    throw new ConflictException({
      statusCode: 409,
      error: 'PLAN_LIMIT_REACHED',
      message: `Gói ${plan.name} chỉ cho phép ${quota.limit} ${resourceLabel[resource]}. Nâng gói để thêm mới.`,
      quota,
      currentPlan: plan,
      suggestedPlans: await this.findUpgradePlans(plan, resource, quota.used + 1),
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

  private toUsage(resource: QuotaResource, used: number, plan: PlanSummary): QuotaUsage {
    const limit = plan[limitFieldByResource[resource]];
    return { resource, used, limit, remaining: Math.max(limit - used, 0) };
  }
}
