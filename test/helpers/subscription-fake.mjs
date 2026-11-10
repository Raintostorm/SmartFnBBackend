import { Prisma } from '../../dist/generated/prisma/client.js';

/** v17.1 catalog (13.1, 31.2) as the migration seeds it. */
export const plan = (overrides) => ({
  description: null,
  isActive: true,
  maxTables: 30,
  extraBranchAccounts: 8,
  extraAccountPackPrice: 50000,
  brandingEnabled: false,
  multiBranchComparisonEnabled: false,
  ...overrides,
  monthlyPrice: new Prisma.Decimal(overrides.monthlyPrice),
});
export const BASIC = plan({ id: 'basic', code: 'BASIC', name: 'Cơ bản', monthlyPrice: 590000, maxBranches: 3, maxAccounts: 30, extraBranchPrice: 250000, extraBranchEnabled: true });
export const STANDARD = plan({ id: 'standard', code: 'STANDARD', name: 'Tiêu chuẩn', monthlyPrice: 1090000, maxBranches: 6, maxAccounts: 55, extraBranchPrice: 220000, extraBranchEnabled: true, brandingEnabled: true, multiBranchComparisonEnabled: true });
export const ADVANCED = plan({ id: 'advanced', code: 'ADVANCED', name: 'Nâng cao', monthlyPrice: 1690000, maxBranches: 10, maxAccounts: 90, extraBranchPrice: 0, extraBranchEnabled: false, brandingEnabled: true, multiBranchComparisonEnabled: true });
export const TRIAL = plan({ id: 'trial', code: 'TRIAL', name: 'Dùng thử', monthlyPrice: 0, maxBranches: 3, maxAccounts: 30, extraBranchPrice: 0, extraAccountPackPrice: 0, extraBranchEnabled: false });
export const CATALOG = [BASIC, STANDARD, ADVANCED, TRIAL];

export const DAY = 86_400_000;

/** In-memory chain: branches and employees with the fields the quota and BR-11 code read. */
export function chainFake({ subscription = {}, periods = [], branches = [], employees = [], owners = 1, tables = 0, catalog = CATALOG } = {}) {
  const state = {
    locks: [],
    audits: [],
    emails: [],
    sessionsRevoked: [],
    periods: periods.map((row, index) => ({ id: `period-${index}`, appliedAt: null, keepBranchIds: null, keepAccountIds: null, ...row })),
    branches: branches.map((row, index) => ({ id: `b${index + 1}`, code: `B${index + 1}`, name: `Chi nhánh ${index + 1}`, status: 'ACTIVE', quotaSuspendedAt: null, deletedAt: null, createdAt: new Date(2026, 0, index + 1), ...row })),
    employees: employees.map((row, index) => ({
      id: `e${index + 1}`, branchId: 'b1', firstName: 'NV', lastName: String(index + 1), deletedAt: null, status: 'ACTIVE', createdAt: new Date(2026, 1, index + 1),
      ...row,
      user: { id: `u${index + 1}`, email: `u${index + 1}@x.vn`, status: 'ACTIVE', staffInvitationState: null, quotaLockedAt: null, role: { code: 'CASHIER' }, ...(row.user ?? {}) },
    })),
    subscription: {
      id: 'sub', chainId: 'chain', planId: BASIC.id, plan: BASIC, nextPlanId: null, nextPlan: null, pendingPlanId: null, pendingPlan: null,
      nextExtraBranches: null, nextAccountPacks: null, nextKeepBranchIds: null, nextKeepAccountIds: null, nextRegisteredByRole: null, nextRegisteredAt: null,
      activeExtraBranches: 0, activeAccountPacks: 0, pendingExtraBranches: 0, pendingAccountPacks: 0, pendingStartsAt: null, pendingMonthlyPrice: null,
      status: 'ACTIVE', monthlyPrice: BASIC.monthlyPrice, startsAt: new Date(Date.now() - 20 * DAY), expiresAt: new Date(Date.now() + 10 * DAY),
      trialStartedAt: null, trialConvertedAt: null,
      ...subscription,
    },
    invoices: [],
    checkouts: [],
    supportActions: [],
  };
  const sub = state.subscription;
  const withPlans = () => ({ ...sub, plan: catalog.find((p) => p.id === sub.planId) ?? sub.plan, nextPlan: catalog.find((p) => p.id === sub.nextPlanId) ?? null, pendingPlan: catalog.find((p) => p.id === sub.pendingPlanId) ?? null });
  const countedBranch = (b) => !b.deletedAt && b.status !== 'INACTIVE';
  const liveBranch = (id) => state.branches.some((b) => b.id === id && !b.deletedAt);
  const countedEmployee = (e) => liveBranch(e.branchId) && !e.deletedAt && e.status !== 'TERMINATED' && e.user.status !== 'SUSPENDED' && e.user.staffInvitationState !== 'CANCELLED';
  const inRange = (where, date) => {
    if (!where) return true;
    if (where.lte && !(date <= where.lte)) return false;
    if (where.lt && !(date < where.lt)) return false;
    if (where.gt && !(date > where.gt)) return false;
    return true;
  };
  const periodMatch = (where = {}) => (row) =>
    (where.subscriptionId === undefined || row.subscriptionId === undefined || row.subscriptionId === where.subscriptionId) &&
    (where.appliedAt === undefined || row.appliedAt === where.appliedAt) &&
    (where.id === undefined || row.id === where.id) &&
    inRange(where.startsAt, row.startsAt) &&
    inRange(where.endsAt, row.endsAt);
  const client = {
    $executeRaw: async (strings, ...values) => { state.locks.push(values.join('')); return 1; },
    $queryRaw: async () => [],
    businessSubscription: {
      findUnique: async () => withPlans(),
      findUniqueOrThrow: async () => withPlans(),
      findFirst: async () => (sub.status === 'ACTIVE' && sub.expiresAt > new Date() ? withPlans() : null),
      update: async ({ data }) => Object.assign(sub, data),
      updateMany: async ({ data }) => { Object.assign(sub, data); return { count: 1 }; },
    },
    subscriptionPeriod: {
      findFirst: async ({ where }) => state.periods.filter(periodMatch(where)).sort((a, b) => b.startsAt - a.startsAt)[0] ?? null,
      findMany: async ({ where }) => state.periods.filter(periodMatch(where)).sort((a, b) => a.startsAt - b.startsAt),
      updateMany: async ({ where, data }) => {
        const rows = state.periods.filter((row) => row.id === where.id && (where.appliedAt === undefined || row.appliedAt === where.appliedAt));
        rows.forEach((row) => Object.assign(row, data));
        return { count: rows.length };
      },
      update: async ({ where, data }) => Object.assign(state.periods.find((row) => row.id === where.id), data),
      upsert: async ({ where, create }) => {
        const key = where.subscriptionId_startsAt;
        const found = state.periods.find((row) => row.startsAt.getTime() === key.startsAt.getTime());
        if (found) return found;
        const row = { id: `period-${state.periods.length}`, appliedAt: null, ...create };
        state.periods.push(row);
        return row;
      },
    },
    servicePlan: {
      findMany: async () => catalog.filter((p) => p.isActive),
      findUnique: async ({ where }) => catalog.find((p) => p.id === where.id) ?? null,
      findUniqueOrThrow: async ({ where }) => catalog.find((p) => p.id === where.id),
    },
    branch: {
      count: async () => state.branches.filter(countedBranch).length,
      findMany: async () => state.branches.filter(countedBranch).sort((a, b) => a.createdAt - b.createdAt),
      update: async ({ where, data }) => Object.assign(state.branches.find((b) => b.id === where.id), data),
    },
    ownerChainAssignment: {
      count: async () => owners,
      findMany: async () => Array.from({ length: owners }, (_, i) => ({ owner: { user: { email: `bm${i}@x.vn` } } })),
    },
    employee: {
      count: async ({ where }) => state.employees.filter(countedEmployee).filter((e) => !where?.AND || e.user.staffInvitationState === 'PENDING').length,
      findMany: async () =>
        state.employees.filter(countedEmployee).sort((a, b) => a.createdAt - b.createdAt).map((e) => ({ ...e, branch: { name: state.branches.find((b) => b.id === e.branchId)?.name } })),
    },
    restaurantTable: { count: async () => tables },
    user: {
      update: async ({ where, data }) => {
        const employee = state.employees.find((e) => e.user.id === where.id);
        Object.assign(employee.user, data);
        return employee.user;
      },
    },
    authSession: { updateMany: async ({ where }) => { state.sessionsRevoked.push(where.userId); return { count: 1 }; } },
    passwordSetupToken: { updateMany: async () => ({ count: 0 }) },
    branchAuditLog: { create: async ({ data }) => { state.audits.push(data); return data; } },
    subscriptionInvoice: {
      updateMany: async ({ data }) => { state.invoices.filter((i) => i.status === 'PENDING').forEach((i) => Object.assign(i, data)); return { count: 1 }; },
      findFirst: async () => state.invoices.find((i) => i.status === 'PENDING') ?? null,
      findMany: async () => state.invoices,
      create: async ({ data }) => { const row = { id: `inv-${state.invoices.length}`, status: 'PENDING', ...data, lines: data.lines.create }; state.invoices.push(row); return row; },
    },
    subscriptionCheckout: {
      findFirst: async () => state.checkouts.find((c) => c.status === 'PENDING') ?? null,
      updateMany: async ({ data }) => { state.checkouts.filter((c) => c.status === 'PENDING').forEach((c) => Object.assign(c, data)); return { count: 1 }; },
    },
    platformSupportAction: { create: async ({ data }) => { state.supportActions.push(data); return data; } },
    emailOutbox: {
      findUnique: async ({ where }) => state.emails.find((row) => row.dedupeKey === where.dedupeKey) ?? null,
      create: async ({ data }) => { const row = { id: `mail-${state.emails.length}`, ...data }; state.emails.push(row); return row; },
    },
  };
  client.$transaction = async (work) => work(client);
  return { client, state };
}
