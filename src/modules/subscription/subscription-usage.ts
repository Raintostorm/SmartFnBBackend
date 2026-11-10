import { BranchStatus, EmployeeStatus, Prisma, UserStatus } from '../../generated/prisma/client.js';
import { ACCOUNT_PACK_SIZE } from './subscription-limits.js';

/**
 * The ONE definition of "used" quota for the whole backend (13.1, BR-11):
 * - branches: not archived and not suspended (Tạm ngưng = INACTIVE);
 * - accounts: every Brand Manager assigned to the chain plus every staff account of a live branch
 *   that is not locked (SUSPENDED) and whose invitation was not cancelled. Pending invitations and
 *   accounts still waiting for a password count, so an invite can never overshoot the limit later.
 */
type Client = Pick<
  Prisma.TransactionClient,
  'branch' | 'employee' | 'ownerChainAssignment' | 'restaurantTable' | 'businessSubscription' | 'subscriptionPeriod'
>;

export const countedBranchWhere = (chainId: string): Prisma.BranchWhereInput => ({
  chainId,
  deletedAt: null,
  status: { not: BranchStatus.INACTIVE },
});

export const countedOwnerWhere = (chainId: string): Prisma.OwnerChainAssignmentWhereInput => ({
  chainId,
  owner: { deletedAt: null, user: { deletedAt: null, status: { not: UserStatus.SUSPENDED } } },
});

export const countedEmployeeWhere = (chainId: string): Prisma.EmployeeWhereInput => ({
  branch: { chainId, deletedAt: null },
  deletedAt: null,
  status: { not: EmployeeStatus.TERMINATED },
  user: {
    deletedAt: null,
    status: { not: UserStatus.SUSPENDED },
    OR: [{ staffInvitationState: null }, { staffInvitationState: { not: 'CANCELLED' } }],
  },
});

export interface UsageCounts {
  branches: number;
  accounts: number;
  tables: number;
  owners: number;
  employees: number;
  pendingInvitations: number;
}

export async function countUsage(client: Client, chainId: string): Promise<UsageCounts> {
  const [branches, owners, employees, pendingInvitations, tables] = await Promise.all([
    client.branch.count({ where: countedBranchWhere(chainId) }),
    client.ownerChainAssignment.count({ where: countedOwnerWhere(chainId) }),
    client.employee.count({ where: countedEmployeeWhere(chainId) }),
    client.employee.count({
      where: { AND: [countedEmployeeWhere(chainId), { user: { staffInvitationState: 'PENDING' } }] },
    }),
    client.restaurantTable.count({ where: { branch: { chainId }, deletedAt: null } }),
  ]);
  return { branches, accounts: owners + employees, tables, owners, employees, pendingInvitations };
}

/** Detail used by the BR-11 keep selection and by the period-start job. Oldest first. */
export async function listCountedUsage(client: Client, chainId: string) {
  const [branches, owners, employees] = await Promise.all([
    client.branch.findMany({
      where: countedBranchWhere(chainId),
      select: { id: true, code: true, name: true, status: true, createdAt: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    }),
    client.ownerChainAssignment.count({ where: countedOwnerWhere(chainId) }),
    client.employee.findMany({
      where: countedEmployeeWhere(chainId),
      select: {
        id: true,
        branchId: true,
        firstName: true,
        lastName: true,
        createdAt: true,
        branch: { select: { name: true } },
        user: {
          select: { id: true, email: true, status: true, staffInvitationState: true, role: { select: { code: true } } },
        },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    }),
  ]);
  return { branches, owners, employees };
}

export interface EffectiveLimits {
  source: 'PERIOD' | 'PLAN';
  periodId: string | null;
  planId: string;
  planCode: string;
  planName: string;
  extraBranches: number;
  accountPacks: number;
  branchLimit: number;
  accountLimit: number;
  tableLimit: number;
  brandingEnabled: boolean;
  multiBranchComparisonEnabled: boolean;
  periodStartsAt: Date;
  periodEndsAt: Date;
}

/**
 * Limits in force right now: the paid period containing `now` (frozen when it was paid), else the
 * live plan plus the add-ons currently active (trials and rows created before periods existed).
 * A paid early period only starts to count at its own start date (BR-70, 31.6).
 */
export async function effectiveLimits(
  client: Client,
  chainId: string,
  now = new Date(),
): Promise<EffectiveLimits | null> {
  const subscription = await client.businessSubscription.findUnique({
    where: { chainId },
    select: {
      id: true,
      startsAt: true,
      expiresAt: true,
      pendingStartsAt: true,
      activeExtraBranches: true,
      activeAccountPacks: true,
      plan: {
        select: {
          id: true,
          code: true,
          name: true,
          maxBranches: true,
          maxAccounts: true,
          maxTables: true,
          extraBranchAccounts: true,
          brandingEnabled: true,
          multiBranchComparisonEnabled: true,
        },
      },
    },
  });
  if (!subscription) return null;
  const period = await client.subscriptionPeriod.findFirst({
    where: { subscriptionId: subscription.id, startsAt: { lte: now }, endsAt: { gt: now } },
    orderBy: { startsAt: 'desc' },
  });
  if (period) {
    return {
      source: 'PERIOD',
      periodId: period.id,
      planId: period.planId,
      planCode: period.planCode,
      planName: period.planName,
      extraBranches: period.extraBranches,
      accountPacks: period.accountPacks,
      branchLimit: period.branchLimit,
      accountLimit: period.accountLimit,
      tableLimit: subscription.plan.maxTables,
      brandingEnabled: period.brandingEnabled,
      multiBranchComparisonEnabled: period.multiBranchComparisonEnabled,
      periodStartsAt: period.startsAt,
      periodEndsAt: period.endsAt,
    };
  }
  const plan = subscription.plan;
  const extraBranches = subscription.activeExtraBranches;
  const accountPacks = subscription.activeAccountPacks;
  return {
    source: 'PLAN',
    periodId: null,
    planId: plan.id,
    planCode: plan.code,
    planName: plan.name,
    extraBranches,
    accountPacks,
    branchLimit: plan.maxBranches + extraBranches,
    accountLimit:
      plan.maxAccounts + extraBranches * plan.extraBranchAccounts + accountPacks * ACCOUNT_PACK_SIZE,
    tableLimit: plan.maxTables,
    brandingEnabled: plan.brandingEnabled,
    multiBranchComparisonEnabled: plan.multiBranchComparisonEnabled,
    periodStartsAt: subscription.startsAt,
    periodEndsAt: subscription.pendingStartsAt ?? subscription.expiresAt,
  };
}
