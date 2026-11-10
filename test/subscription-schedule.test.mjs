import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Prisma } from '../dist/generated/prisma/client.js';
import { SubscriptionScheduleService } from '../dist/modules/subscription/subscription-schedule.service.js';

const basic = {
  id: 'basic', code: 'BASIC', name: 'Cơ bản', isActive: true,
  monthlyPrice: new Prisma.Decimal(590000), maxBranches: 3, maxAccounts: 30,
  extraBranchPrice: 250000, extraBranchAccounts: 8, extraAccountPackPrice: 50000, extraBranchEnabled: true,
};
const standard = { ...basic, id: 'standard', code: 'STANDARD', name: 'Tiêu chuẩn', monthlyPrice: new Prisma.Decimal(1090000), maxBranches: 6 };

function fixture(overrides = {}) {
  const sub = {
    id: 'sub', chainId: 'chain', planId: 'basic', plan: basic,
    nextPlanId: null, nextPlan: null, nextExtraBranches: null, nextAccountPacks: null,
    activeExtraBranches: 0, activeAccountPacks: 0,
    pendingPlanId: null, pendingStartsAt: null,
    status: 'ACTIVE', expiresAt: new Date(Date.now() + 5 * 86_400_000),
    ...overrides,
  };
  let invoice;
  const tx = {
    $executeRaw: async () => undefined,
    subscriptionInvoice: {
      findFirst: async () => invoice,
      create: async ({ data }) => {
        invoice = { id: 'invoice', ...data, status: 'PENDING', lines: data.lines.create };
        return invoice;
      },
      updateMany: async () => undefined,
    },
    subscriptionCheckout: { updateMany: async () => undefined },
    businessSubscription: { update: async ({ data }) => Object.assign(sub, data) },
  };
  const prisma = {
    businessSubscription: {
      findUnique: async () => sub,
      findUniqueOrThrow: async () => sub,
      updateMany: async ({ data }) => Object.assign(sub, data),
    },
    servicePlan: {
      findUnique: async ({ where }) => where.id === standard.id ? standard : basic,
      findFirst: async () => standard,
    },
    subscriptionCheckout: { findFirst: async () => null },
    subscriptionInvoice: { findFirst: async () => invoice },
    $transaction: async (fn) => fn(tx),
  };
  return { service: new SubscriptionScheduleService(prisma, {}, {}), sub, getInvoice: () => invoice };
}

describe('Subscription next period', () => {
  it('freezes a multi-line invoice with the registered add-ons', async () => {
    const { service, sub } = fixture({ nextExtraBranches: 1, nextAccountPacks: 1 });
    const preview = await service.preview('chain');
    assert.equal(preview.total, 890000);
    assert.equal(preview.branchLimit, 4);
    assert.equal(preview.accountLimit, 43);
    const invoice = await service.getOrCreateInvoice('chain');
    assert.equal(invoice.total, 890000);
    assert.deepEqual(invoice.lines.map((line) => line.amount), [590000, 250000, 50000]);
    assert.equal((await service.getOrCreateInvoice('chain')).id, invoice.id);
    assert.equal(sub.planId, 'basic');
  });

  it('rejects a second Basic extra branch when Standard costs no more (BR-92)', async () => {
    const { service } = fixture({ nextExtraBranches: 2 });
    await assert.rejects(service.preview('chain'), (error) => error.getResponse().error === 'ADDON_UPGRADE_BETTER');
  });

  it('activates a paid future plan only when its period begins', async () => {
    const start = new Date(Date.now() + 86_400_000);
    const { service, sub } = fixture({ pendingPlanId: 'standard', pendingStartsAt: start, pendingExtraBranches: 1, pendingAccountPacks: 2, pendingMonthlyPrice: new Prisma.Decimal(1090000) });
    await service.activateDue('chain');
    assert.equal(sub.planId, 'basic');
    sub.pendingStartsAt = new Date(Date.now() - 1000);
    await service.activateDue('chain');
    assert.equal(sub.planId, 'standard');
    assert.equal(sub.activeExtraBranches, 1);
    assert.equal(sub.activeAccountPacks, 2);
  });
});
