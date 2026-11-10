import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import {
  addonViolation,
  carryOverAddons,
  computeLimits,
  invoiceLines,
  maxSellableExtraBranches,
} from '../dist/modules/subscription/subscription-limits.js';
import { PlanQuotaService } from '../dist/modules/subscription/plan-quota.service.js';
import { SubscriptionScheduleService } from '../dist/modules/subscription/subscription-schedule.service.js';
import { BranchesService } from '../dist/modules/branches/branches.service.js';
import { dueMilestone, SubscriptionInvoiceWorker, vnDaysUntil } from '../dist/modules/platform-billing/subscription-invoice.worker.js';
import { ADVANCED, BASIC, CATALOG, chainFake, DAY, STANDARD, TRIAL } from './helpers/subscription-fake.mjs';

const conflict = (code) => (error) => {
  assert.equal(error.getStatus(), 409);
  assert.equal(error.getResponse().error, code);
  return true;
};
const period = (overrides) => ({
  subscriptionId: 'sub', chainId: 'chain', planId: BASIC.id, planCode: 'BASIC', planName: 'Cơ bản', monthlyPrice: 590000,
  planMaxBranches: 3, planMaxAccounts: 30, extraBranches: 0, accountPacks: 0, branchLimit: 3, accountLimit: 30,
  brandingEnabled: false, multiBranchComparisonEnabled: false, source: 'PAYOS',
  startsAt: new Date(Date.now() - 20 * DAY), endsAt: new Date(Date.now() + 10 * DAY), appliedAt: new Date(),
  ...overrides,
});

describe('v17.1 catalog arithmetic (13.1, 31.2, BR-91, BR-92)', () => {
  it('prices the four mandatory BR-92 examples', () => {
    assert.equal(addonViolation(BASIC, { extraBranches: 1, accountPacks: 0 }, CATALOG), null, 'BASIC +1 = 840.000đ is allowed');
    const basic2 = addonViolation(BASIC, { extraBranches: 2, accountPacks: 0 }, CATALOG);
    assert.equal(basic2.error, 'ADDON_UPGRADE_BETTER');
    assert.equal(basic2.selectionTotal, 1_090_000);
    assert.equal(basic2.suggestedPlan.code, 'STANDARD');
    assert.equal(addonViolation(STANDARD, { extraBranches: 2, accountPacks: 0 }, CATALOG), null, 'STANDARD +2 = 1.530.000đ is allowed');
    const standard3 = addonViolation(STANDARD, { extraBranches: 3, accountPacks: 0 }, CATALOG);
    assert.equal(standard3.error, 'ADDON_UPGRADE_BETTER');
    assert.equal(standard3.selectionTotal, 1_750_000);
    assert.equal(standard3.suggestedPlan.code, 'ADVANCED');
    assert.equal(maxSellableExtraBranches(BASIC, CATALOG), 1);
    assert.equal(maxSellableExtraBranches(STANDARD, CATALOG), 2);
    assert.equal(maxSellableExtraBranches(ADVANCED, CATALOG), 0);
  });

  it('caps account packs at 4, never sells add-ons on trial or above 10 branches', () => {
    assert.equal(addonViolation(BASIC, { extraBranches: 0, accountPacks: 4 }, CATALOG), null);
    assert.equal(addonViolation(BASIC, { extraBranches: 0, accountPacks: 5 }, CATALOG).error, 'INVALID_ADDON_QUANTITY');
    assert.equal(addonViolation(TRIAL, { extraBranches: 0, accountPacks: 1 }, CATALOG).error, 'ADDON_NOT_SOLD');
    assert.equal(addonViolation(TRIAL, { extraBranches: 1, accountPacks: 0 }, CATALOG).error, 'ADDON_NOT_SOLD');
    assert.equal(addonViolation(ADVANCED, { extraBranches: 1, accountPacks: 0 }, CATALOG).error, 'ADDON_NOT_SOLD');
    const lonely = [{ ...STANDARD, extraBranchPrice: 1 }];
    assert.equal(addonViolation(lonely[0], { extraBranches: 5, accountPacks: 0 }, lonely).error, 'MAX_BRANCHES_EXCEEDED');
  });

  it('computes limits and a three-line invoice: BASIC +1 branch +1 pack = 4 / 43, 890.000đ', () => {
    assert.deepEqual(computeLimits(BASIC, { extraBranches: 1, accountPacks: 1 }), { branchLimit: 4, accountLimit: 43 });
    const lines = invoiceLines(BASIC, { extraBranches: 1, accountPacks: 1 });
    assert.deepEqual(lines.map((line) => [line.kind, line.quantity, line.unitPrice, line.amount]), [
      ['PLAN', 1, 590000, 590000],
      ['EXTRA_BRANCH', 1, 250000, 250000],
      ['ACCOUNT_PACK', 1, 50000, 50000],
    ]);
  });

  it('drops extra branches on an upgrade that covers them and trims them on a downgrade', () => {
    const up = carryOverAddons(BASIC, { extraBranches: 1, accountPacks: 2 }, STANDARD, CATALOG);
    assert.deepEqual(up.selection, { extraBranches: 0, accountPacks: 2 });
    assert.equal(up.warnings.length, 1);
    const down = carryOverAddons(STANDARD, { extraBranches: 2, accountPacks: 1 }, BASIC, CATALOG);
    assert.deepEqual(down.selection, { extraBranches: 1, accountPacks: 1 });
    assert.match(down.warnings.join(' '), /BR-92/);
  });
});

describe('One quota rule for the whole backend', () => {
  it('counts Brand Managers, staff and pending invitations, not locked or cancelled accounts', async () => {
    const { client } = chainFake({
      owners: 1,
      branches: [{}],
      employees: [{}, {}, { user: { status: 'INACTIVE', staffInvitationState: 'PENDING' } }, { user: { status: 'SUSPENDED' } }, { user: { status: 'INACTIVE', staffInvitationState: 'CANCELLED' } }],
    });
    const snapshot = await new PlanQuotaService(client).getSubscriptionSnapshot('chain');
    assert.deepEqual(snapshot.quotas.find((q) => q.resource === 'accounts'), { resource: 'accounts', used: 4, limit: 30, remaining: 26 });
    assert.deepEqual(snapshot.accountUsage, { owners: 1, employees: 3, pendingInvitations: 1 });
  });

  it('reads the frozen period limits: plan + 8 × extra branches + 5 × packs', async () => {
    const { client } = chainFake({ branches: [{}], periods: [period({ extraBranches: 1, accountPacks: 2, branchLimit: 4, accountLimit: 48 })] });
    const snapshot = await new PlanQuotaService(client).getSubscriptionSnapshot('chain');
    assert.equal(snapshot.effective.source, 'PERIOD');
    assert.equal(snapshot.quotas.find((q) => q.resource === 'branches').limit, 4);
    assert.equal(snapshot.quotas.find((q) => q.resource === 'accounts').limit, 48);
  });

  it('keeps the current limit after an early payment until the next period starts (BR-70)', async () => {
    const start = new Date(Date.now() + 10 * DAY);
    const { client } = chainFake({
      branches: [{}, {}, {}],
      periods: [period({ endsAt: start }), period({ planId: STANDARD.id, planCode: 'STANDARD', planName: 'Tiêu chuẩn', branchLimit: 6, accountLimit: 55, startsAt: start, endsAt: new Date(start.getTime() + 30 * DAY), appliedAt: null, brandingEnabled: true })],
    });
    const quota = new PlanQuotaService(client);
    await assert.rejects(quota.assertWithinQuota('chain', 'branches'), (error) => {
      const body = error.getResponse();
      assert.equal(body.error, 'PLAN_LIMIT_REACHED');
      assert.equal(body.limit, 3);
      assert.equal(body.used, 3);
      assert.equal(new Date(body.effectiveFrom).getTime(), start.getTime());
      assert.ok(body.suggestedPlans.some((p) => p.code === 'STANDARD'));
      assert.deepEqual({ extraBranches: body.suggestedAddons.extraBranches }, { extraBranches: 1 });
      return true;
    });
    await assert.rejects(quota.assertFeatureEnabled('chain', 'BRANDING'), (error) => error.getStatus() === 403);
  });

  it('falls back to the live plan and active add-ons for legacy rows without periods', async () => {
    const { client } = chainFake({ subscription: { activeExtraBranches: 1, activeAccountPacks: 1 } });
    const snapshot = await new PlanQuotaService(client).getSubscriptionSnapshot('chain');
    assert.equal(snapshot.effective.source, 'PLAN');
    assert.equal(snapshot.effective.branchLimit, 4);
    assert.equal(snapshot.effective.accountLimit, 43);
  });

  it('serialises writers with a chain lock and blocks a creation outside the next-period keep list', async () => {
    const { client, state } = chainFake({
      branches: [{}, {}],
      subscription: { activeExtraBranches: 1, nextExtraBranches: 0, nextKeepBranchIds: ['b1', 'b2', 'b3'].slice(0, 3) },
    });
    // Next period: BASIC without the extra branch = 3 branches; keep list [b1, b2, b3] is full.
    await assert.rejects(new PlanQuotaService(client).assertCanAdd(client, 'chain', 'branches'), conflict('NEXT_PERIOD_KEEP_SELECTION_REQUIRED'));
    assert.ok(state.locks.includes('quota:chain'));
    state.subscription.nextKeepBranchIds = ['b1', 'b2'];
    const reserve = await new PlanQuotaService(client).assertCanAdd(client, 'chain', 'branches');
    await reserve('b-new');
    assert.deepEqual(state.subscription.nextKeepBranchIds, ['b1', 'b2', 'b-new']);
  });

  it('keeps expired and suspended subscriptions visible with their quota', async () => {
    const expired = chainFake({ branches: [{}, {}], subscription: { expiresAt: new Date('2020-01-01T00:00:00.000Z') } });
    const snapshot = await new PlanQuotaService(expired.client).getSubscriptionSnapshot('chain');
    assert.equal(snapshot.status, 'EXPIRED');
    assert.equal(snapshot.expiresAt.toISOString(), '2020-01-01T00:00:00.000Z');
    assert.deepEqual(snapshot.quotas.find((q) => q.resource === 'branches'), { resource: 'branches', used: 2, limit: 3, remaining: 1 });
    const suspended = chainFake({ subscription: { status: 'SUSPENDED' } });
    assert.equal((await new PlanQuotaService(suspended.client).getSubscriptionSnapshot('chain')).status, 'SUSPENDED');
  });

  it('reopens a suspended branch only within the current limit', async () => {
    const { client, state } = chainFake({ branches: [{}, {}, {}, { status: 'INACTIVE', quotaSuspendedAt: new Date() }] });
    client.branch.findFirst = async ({ where }) => state.branches.find((b) => b.id === where.id);
    const branches = new BranchesService(client, { assertCanManageBranch: async () => undefined }, new PlanQuotaService(client));
    const ownerUser = { role: 'OWNER', ownerId: 'o' };
    await assert.rejects(branches.updateBranchStatus('b4', 'ACTIVE', ownerUser), conflict('PLAN_LIMIT_REACHED'));
    assert.equal(state.branches[3].status, 'INACTIVE');
    state.branches[2].status = 'INACTIVE';
    await branches.updateBranchStatus('b4', 'ACTIVE', ownerUser);
    assert.equal(state.branches[3].status, 'ACTIVE');
    assert.equal(state.branches[3].quotaSuspendedAt, null);
  });
});

describe('Next-period registration (BR-90, BR-11, BR-74)', () => {
  const service = (client) => new SubscriptionScheduleService(client, {}, {});

  it('rejects a direct API call that violates BR-92 and issues no invoice', async () => {
    const { client, state } = chainFake();
    await assert.rejects(service(client).putNextAddons('chain', 2, 0), conflict('ADDON_UPGRADE_BETTER'));
    assert.equal(state.invoices.length, 0);
    assert.equal(state.subscription.nextExtraBranches, null);
  });

  it('keeps the current plan and limits while registering a bigger plan for the next period', async () => {
    const { client, state } = chainFake({ branches: [{}, {}, {}] });
    const preview = await service(client).putNextPlan('chain', STANDARD.id, {}, { role: 'BRAND_MANAGER', userId: 'bm' });
    assert.equal(state.subscription.planId, BASIC.id);
    assert.equal(state.subscription.nextPlanId, STANDARD.id);
    assert.equal(preview.total, 1_090_000);
    assert.equal(preview.branchLimit, 6);
    assert.equal(new Date(preview.startsAt).getTime(), state.subscription.expiresAt.getTime());
    assert.equal(state.emails.length, 1, 'registration confirmation queued');
  });

  it('requires a keep list when the next limit is below current usage and reports how many to drop', async () => {
    const { client, state } = chainFake({ subscription: { activeExtraBranches: 1 }, branches: [{}, {}, {}, {}] });
    await assert.rejects(service(client).putNextAddons('chain', 0, 0), (error) => {
      const body = error.getResponse();
      assert.equal(body.error, 'KEEP_SELECTION_REQUIRED');
      assert.equal(body.resource, 'branches');
      assert.equal(body.mustRemove, 1);
      assert.ok(body.effectiveFrom);
      return true;
    });
    await assert.rejects(service(client).putNextAddons('chain', 0, 0, { keepBranchIds: ['b1', 'b2', 'foreign'] }), conflict('KEEP_LIST_INVALID'));
    await assert.rejects(service(client).putNextAddons('chain', 0, 0, { keepBranchIds: ['b1', 'b2', 'b3', 'b4'] }), conflict('KEEP_LIST_TOO_LONG'));
    await assert.rejects(service(client).putNextAddons('chain', 0, 0, { keepBranchIds: ['b1', 'b1', 'b2'] }), conflict('KEEP_LIST_DUPLICATE'));
    await service(client).putNextAddons('chain', 0, 0, { keepBranchIds: ['b1', 'b2', 'b4'] });
    assert.deepEqual(state.subscription.nextKeepBranchIds, ['b1', 'b2', 'b4']);
    assert.equal(state.branches[2].status, 'ACTIVE', 'nothing is suspended before the period starts');
  });

  it('always keeps the Brand Manager and locks accounts of dropped branches with them', async () => {
    const employees = [...Array.from({ length: 30 }, () => ({ branchId: 'b1' })), { branchId: 'b4' }, { branchId: 'b4' }];
    const { client, state } = chainFake({ owners: 1, subscription: { activeExtraBranches: 1, activeAccountPacks: 1 }, branches: [{}, {}, {}, {}], employees });
    // Next period BASIC alone: 3 branches, 30 accounts (1 BM + 29 staff). b4 dropped → its 2 staff follow.
    await assert.rejects(service(client).putNextAddons('chain', 0, 0, { keepBranchIds: ['b1', 'b2', 'b3'] }), (error) => {
      const body = error.getResponse();
      assert.equal(body.resource, 'accounts');
      assert.equal(body.mustRemove, 1);
      assert.equal(body.lockedWithBranches, 2);
      return true;
    });
    await assert.rejects(
      service(client).putNextAddons('chain', 0, 0, { keepBranchIds: ['b1', 'b2', 'b3'], keepAccountIds: ['e31', ...Array.from({ length: 28 }, (_, i) => `e${i + 1}`)] }),
      conflict('ACCOUNT_BRANCH_NOT_KEPT'),
    );
    const keep = Array.from({ length: 29 }, (_, i) => `e${i + 1}`);
    await service(client).putNextAddons('chain', 0, 0, { keepBranchIds: ['b1', 'b2', 'b3'], keepAccountIds: keep });
    assert.deepEqual(state.subscription.nextKeepAccountIds, keep);
  });

  it('cancels the unpaid next invoice and PayOS link when the registration changes', async () => {
    const { client, state } = chainFake();
    state.invoices.push({ id: 'old', status: 'PENDING', lines: [] });
    await service(client).putNextAddons('chain', 1, 0);
    assert.equal(state.invoices[0].status, 'CANCELLED');
  });

  it('lets Platform Staff register plan and add-ons only with a note, audited', async () => {
    const { client, state } = chainFake();
    await assert.rejects(service(client).register('chain', { planId: STANDARD.id }, { role: 'PLATFORM_STAFF', userId: 'staff' }), (error) => error.getStatus() === 400);
    await service(client).register('chain', { planId: STANDARD.id, accountPacks: 2 }, { role: 'PLATFORM_STAFF', userId: 'staff', note: 'Khách gọi điện yêu cầu' });
    assert.equal(state.subscription.nextPlanId, STANDARD.id);
    assert.equal(state.subscription.nextAccountPacks, 2);
    assert.equal(state.subscription.nextRegisteredByRole, 'PLATFORM_STAFF');
    assert.equal(state.supportActions[0].action, 'SCHEDULE_NEXT_PERIOD');
    assert.equal(state.subscription.planId, BASIC.id, 'staff never changes the current period');
  });

  it('dry-runs a draft without saving it (FE pre-check)', async () => {
    const { client, state } = chainFake();
    const preview = await service(client).preview('chain', { extraBranches: 2 });
    assert.equal(preview.violation.error, 'ADDON_UPGRADE_BETTER');
    assert.equal(preview.violation.suggestedPlan.code, 'STANDARD');
    assert.equal(state.subscription.nextExtraBranches, null);
  });
});

describe('Period start applies BR-11 exactly once', () => {
  it('suspends branches and locks accounts outside the keep list, audited, keeping manual states', async () => {
    const start = new Date(Date.now() - 1000);
    const { client, state } = chainFake({
      owners: 1,
      branches: [{}, {}, {}, {}, { status: 'INACTIVE' }],
      employees: [{ branchId: 'b1' }, { branchId: 'b4' }, { branchId: 'b2' }, { branchId: 'b5' }],
      periods: [period({ startsAt: start, endsAt: new Date(start.getTime() + 30 * DAY), appliedAt: null, branchLimit: 3, accountLimit: 3, keepBranchIds: ['b1', 'b2', 'b3'], keepAccountIds: ['e1'] })],
    });
    const schedule = new SubscriptionScheduleService(client, {}, {});
    await schedule.activateDue('chain');
    assert.deepEqual(state.branches.map((b) => b.status), ['ACTIVE', 'ACTIVE', 'ACTIVE', 'INACTIVE', 'INACTIVE']);
    assert.ok(state.branches[3].quotaSuspendedAt);
    assert.equal(state.branches[4].quotaSuspendedAt, null, 'manual suspension is not re-labelled');
    // capacity 3 - 1 BM = 2 staff; e2 follows b4; keep list holds e1 only → e3 locked, e4 (manual branch) locked too.
    assert.deepEqual(state.employees.map((e) => e.user.status), ['ACTIVE', 'SUSPENDED', 'SUSPENDED', 'SUSPENDED']);
    assert.ok(state.employees[1].user.quotaLockedAt);
    assert.ok(state.audits.every((audit) => audit.reason === 'vượt hạn mức gói'));
    const audits = state.audits.length;
    await schedule.activateDue('chain');
    assert.equal(state.audits.length, audits, 'a second run (or instance) does nothing');
  });

  it('does not touch anything before the paid period starts', async () => {
    const { client, state } = chainFake({
      branches: [{}, {}, {}, {}],
      periods: [period({ startsAt: new Date(Date.now() + DAY), endsAt: new Date(Date.now() + 31 * DAY), appliedAt: null, branchLimit: 3, keepBranchIds: ['b1', 'b2', 'b3'] })],
    });
    await new SubscriptionScheduleService(client, {}, {}).activateDue('chain');
    assert.ok(state.branches.every((b) => b.status === 'ACTIVE'));
  });
});

describe('Renewal reminders (25.5)', () => {
  it('maps days left to exactly one milestone in Vietnam time', () => {
    const now = new Date('2026-12-20T03:00:00.000Z');
    assert.equal(vnDaysUntil(new Date('2026-12-27T03:00:00.000Z'), now), 7);
    assert.equal(dueMilestone(7), 7);
    assert.equal(dueMilestone(5), 7);
    assert.equal(dueMilestone(3), 3);
    assert.equal(dueMilestone(0), 0);
    assert.equal(dueMilestone(-1), null);
    assert.equal(dueMilestone(9), null);
  });

  it('never sends the same reminder twice when the job runs again', async () => {
    const { client, state } = chainFake({ owners: 2, subscription: { expiresAt: new Date(Date.now() + 3 * DAY - 60_000) } });
    client.businessSubscription.findMany = async () => [{ id: 'sub', chainId: 'chain', expiresAt: state.subscription.expiresAt, invoices: [] }];
    const worker = new SubscriptionInvoiceWorker(client, new SubscriptionScheduleService(client, {}, {}));
    await worker.sendReminders();
    await worker.sendReminders();
    assert.equal(state.emails.length, 2, 'one per Brand Manager');
    assert.match(state.emails[0].dedupeKey, /subscription-reminder:sub:.*:3:0/);
  });
});

describe('Catalog migration', () => {
  it('snapshots periods before changing prices and only updates untouched bootstrap rows', async () => {
    const sql = await readFile(new URL('../prisma/migrations/20261111000100_subscription_v17_1/migration.sql', import.meta.url), 'utf8');
    assert.ok(sql.indexOf('INSERT INTO "subscription_periods"') < sql.indexOf('UPDATE "service_plans"'), 'backfill runs first');
    assert.match(sql, /"monthly_price" = 590000, "max_branches" = 3, "max_accounts" = 30[\s\S]*WHERE "code" = 'BASIC' AND "monthly_price" = 300000 AND "max_branches" = 2 AND "max_accounts" = 10/);
    assert.match(sql, /'STANDARD', 'Tiêu chuẩn'[^;]*1090000, 6, 55/);
    assert.match(sql, /'ADVANCED', 'Nâng cao'[^;]*1690000, 10, 90/);
    assert.match(sql, /ON CONFLICT \("code"\) DO NOTHING/);
    assert.doesNotMatch(sql, /UPDATE "subscription_invoices"|UPDATE "subscription_invoice_lines"|DELETE FROM/);
    assert.match(sql, /CREATE UNIQUE INDEX "refund_documents_refund_id_key"/);
  });
});
