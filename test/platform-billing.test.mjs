import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Prisma } from '../dist/generated/prisma/client.js';
import { PlatformBillingService } from '../dist/modules/platform-billing/platform-billing.service.js';
import { payosSignature } from '../dist/modules/payos/payos-signature.js';
import { SubscriptionScheduleService } from '../dist/modules/subscription/subscription-schedule.service.js';

const config = {
  get: (name) =>
    ({
      PLATFORM_PAYOS_CLIENT_ID: 'platform-client',
      PLATFORM_PAYOS_API_KEY: 'platform-api',
      PLATFORM_PAYOS_CHECKSUM_KEY: 'platform-checksum',
      PUBLIC_WEB_URL: 'https://smartfnb.tech',
    })[name],
};
const user = { role: 'OWNER', ownerId: 'owner-1' };
const access = { assertCanAccessChain: async (_user, chainId) => assert.equal(chainId, 'chain-1') };
const trial = {
  id: 'sub-1',
  planId: 'trial-id',
  plan: { code: 'TRIAL' },
  trialStartedAt: new Date(),
  trialConvertedAt: null,
  expiresAt: new Date(Date.now() + 14 * 86_400_000),
  status: 'ACTIVE',
};
const paidPlan = {
  id: 'basic-id',
  code: 'BASIC',
  name: 'Cơ bản',
  isActive: true,
  monthlyPrice: new Prisma.Decimal(299000),
  maxBranches: 3,
  maxAccounts: 30,
  extraBranchAccounts: 8,
  extraBranchPrice: 250000,
  extraAccountPackPrice: 50000,
  extraBranchEnabled: true,
  brandingEnabled: false,
  multiBranchComparisonEnabled: false,
};
const standardPlan = { ...paidPlan, id: 'standard-id', code: 'STANDARD', name: 'Tiêu chuẩn', monthlyPrice: new Prisma.Decimal(499000), maxBranches: 6, maxAccounts: 55 };
const schedule = { activateDue: async () => undefined };
/** The real shared payment application; it only touches the transaction it is given. */
const realSchedule = new SubscriptionScheduleService({}, config, {});
/** Tables the payment transaction writes besides the subscription: periods, keep lists, receipt email. */
const ledger = { periods: [], emails: [] };
function periodTx() {
  return {
    subscriptionPeriod: {
      upsert: async ({ where, create }) => {
        const found = ledger.periods.find((row) => row.subscriptionId === where.subscriptionId_startsAt.subscriptionId && row.startsAt.getTime() === where.subscriptionId_startsAt.startsAt.getTime());
        if (found) return found;
        const row = { id: `period-${ledger.periods.length + 1}`, appliedAt: null, ...create };
        ledger.periods.push(row);
        return row;
      },
      updateMany: async ({ where, data }) => {
        const row = ledger.periods.find((item) => item.id === where.id && item.appliedAt === null);
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
    branch: { findMany: async () => [], update: async () => ({}) },
    employee: { findMany: async () => [] },
    ownerChainAssignment: {
      count: async () => 1,
      findMany: async () => [{ owner: { user: { email: 'owner@example.com' } } }],
    },
    emailOutbox: {
      findUnique: async ({ where }) => ledger.emails.find((row) => row.dedupeKey === where.dedupeKey) ?? null,
      create: async ({ data }) => {
        const row = { id: `email-${ledger.emails.length + 1}`, ...data };
        ledger.emails.push(row);
        return row;
      },
    },
  };
}

describe('Platform subscription PayOS checkout', () => {
  it('lets an expired trial Owner start a paid checkout through platform credentials', async () => {
    let paymentRequest;
    const prisma = {
      businessSubscription: { findUnique: async () => ({ ...trial, expiresAt: new Date(0) }) },
      servicePlan: { findUnique: async () => paidPlan },
      subscriptionInvoice: { updateMany: async () => ({}), create: async ({ data }) => ({ id: 'invoice-1', total: data.total }) },
      subscriptionCheckout: {
        findFirst: async () => null,
        create: async ({ data }) => ({
          id: 'checkout-1',
          ...data,
          amount: new Prisma.Decimal(data.amount),
          status: 'PENDING',
          createdAt: new Date(),
          checkoutUrl: null,
          paidAt: null,
        }),
        update: async ({ data }) => ({
          id: 'checkout-1',
          planId: paidPlan.id,
          amount: new Prisma.Decimal(299000),
          status: 'PENDING',
          paidAt: null,
          ...data,
        }),
      },
    };
    const payos = {
      createPayment: async (credentials, request) => {
        assert.equal(credentials.clientId, 'platform-client');
        paymentRequest = request;
        return { checkoutUrl: 'https://pay.payos.vn/link', paymentLinkId: 'payment-1' };
      },
    };
    const service = new PlatformBillingService(prisma, config, access, payos, {}, {}, schedule);
    const result = await service.createCheckout(user, 'chain-1', paidPlan.id);
    assert.equal(result.status, 'PENDING');
    assert.equal(result.checkoutUrl, 'https://pay.payos.vn/link');
    assert.equal(paymentRequest.amount, 299000);
    assert.match(paymentRequest.returnUrl, /\/owner\/plan\?checkout=checkout-1/);
  });

  it('rejects invalid signatures and flags signed amount mismatches for review', async () => {
    let activated = 0;
    let reviewStatus;
    const checkout = { id: 'checkout-1', providerOrderCode: '123', chainId: 'chain-1', amount: new Prisma.Decimal(299000), status: 'PENDING' };
    const prisma = {
      subscriptionCheckout: { findUnique: async () => checkout },
      $transaction: async (callback) => callback({
        ...periodTx(),
        $executeRaw: async () => 1,
        subscriptionCheckout: {
          findUniqueOrThrow: async () => checkout,
          update: async ({ data }) => { reviewStatus = data.status; },
        },
        businessSubscription: { update: async () => { activated++; } },
      }),
    };
    const service = new PlatformBillingService(prisma, config, access, {}, {}, {}, realSchedule);
    const data = { orderCode: 123, amount: 299000 };
    await assert.rejects(
      service.webhook({ code: '00', success: true, data, signature: 'bad' }),
      (error) => error.getStatus() === 401,
    );
    assert.deepEqual(
      await service.webhook({
        code: '00',
        success: true,
        data: { ...data, amount: 1 },
        signature: payosSignature({ ...data, amount: 1 }, 'platform-checksum'),
      }),
      { success: true },
    );
    assert.equal(activated, 0);
    assert.equal(reviewStatus, 'NEEDS_REVIEW');
  });

  it('does not activate a second paid checkout after trial conversion', async () => {
    let reviewStatus;
    const checkout = { id: 'checkout-2', providerOrderCode: '456', chainId: 'chain-1', amount: new Prisma.Decimal(299000), status: 'PENDING' };
    const prisma = {
      subscriptionCheckout: { findUnique: async () => checkout },
      $transaction: async (callback) => callback({
        ...periodTx(),
        $executeRaw: async () => 1,
        subscriptionCheckout: {
          findUniqueOrThrow: async () => checkout,
          update: async ({ data }) => { reviewStatus = data.status; },
        },
        businessSubscription: { findUnique: async () => ({ ...trial, trialConvertedAt: new Date() }), update: async () => assert.fail('must not activate twice') },
      }),
    };
    const service = new PlatformBillingService(prisma, config, access, {}, {}, {}, realSchedule);
    const data = { orderCode: 456, amount: 299000 };
    assert.deepEqual(await service.webhook({ code: '00', success: true, data, signature: payosSignature(data, 'platform-checksum') }), { success: true });
    assert.equal(reviewStatus, 'NEEDS_REVIEW');
  });

  it('activates one paid month only once on a signed webhook', async () => {
    let status = 'PENDING';
    let subscriptionUpdate;
    let events = 0;
    const checkout = {
      id: 'checkout-1',
      providerOrderCode: '123',
      amount: new Prisma.Decimal(299000),
      planId: paidPlan.id,
      chainId: 'chain-1',
    };
    const tx = {
      ...periodTx(),
      $executeRaw: async () => 1,
      subscriptionCheckout: {
        findUniqueOrThrow: async () => ({ ...checkout, status }),
        update: async ({ data }) => {
          status = data.status;
        },
      },
      businessSubscription: {
        findUnique: async () => trial,
        update: async ({ data }) => {
          subscriptionUpdate = data;
        },
      },
      businessSubscriptionEvent: {
        create: async () => {
          events++;
        },
      },
      servicePlan: { findUniqueOrThrow: async () => paidPlan },
    };
    const prisma = {
      subscriptionCheckout: { findUnique: async () => checkout },
      $transaction: async (callback) => callback(tx),
    };
    const service = new PlatformBillingService(prisma, config, access, {}, {}, {}, realSchedule);
    const data = { orderCode: 123, amount: 299000 };
    const payload = {
      code: '00',
      success: true,
      data,
      signature: payosSignature(data, 'platform-checksum'),
    };
    assert.deepEqual(await service.webhook(payload), { success: true });
    assert.equal(subscriptionUpdate.planId, paidPlan.id);
    assert.equal(subscriptionUpdate.status, 'ACTIVE');
    assert.ok(subscriptionUpdate.startsAt instanceof Date);
    assert.ok(
      subscriptionUpdate.expiresAt.getTime() - subscriptionUpdate.startsAt.getTime() >=
        28 * 86_400_000,
    );
    assert.equal(events, 1);
    const periods = ledger.periods.length;
    const emails = ledger.emails.length;
    // A replayed webhook neither adds a period nor sends a second receipt.
    assert.deepEqual(await service.webhook(payload), { success: true });
    assert.equal(events, 1);
    assert.equal(ledger.periods.length, periods);
    assert.equal(ledger.emails.length, emails);
    const period = ledger.periods.at(-1);
    assert.equal(period.planId, paidPlan.id);
    assert.equal(period.branchLimit, 3);
    assert.equal(period.accountLimit, 30);
    assert.ok(period.appliedAt, 'a trial conversion starts its paid period at once');
    assert.match(ledger.emails.at(-1).dedupeKey, /^subscription-receipt:/);
  });

  it('renews a paid business on the scheduled plan only after verified payment', async () => {
    const checkout = { id: 'renewal-1', providerOrderCode: '789', chainId: 'chain-1', planId: 'standard-id', amount: new Prisma.Decimal(499000), status: 'PENDING' };
    const currentExpiry = new Date(Date.now() + 2 * 86_400_000);
    let updated;
    let checkoutStatus = 'PENDING';
    const tx = {
      ...periodTx(),
      $executeRaw: async () => 1,
      subscriptionCheckout: { findUniqueOrThrow: async () => ({ ...checkout, status: checkoutStatus }), update: async ({ data }) => { checkoutStatus = data.status; } },
      businessSubscription: { findUnique: async () => ({ id: 'sub-paid', chainId: 'chain-1', planId: 'basic-id', nextPlanId: 'standard-id', plan: { code: 'BASIC' }, status: 'ACTIVE', monthlyPrice: new Prisma.Decimal(299000), expiresAt: currentExpiry, trialStartedAt: null, trialConvertedAt: null }), update: async ({ data }) => { updated = data; } },
      businessSubscriptionEvent: { create: async () => ({}) },
      servicePlan: { findUniqueOrThrow: async () => standardPlan },
    };
    const prisma = { subscriptionCheckout: { findUnique: async () => checkout }, $transaction: async (work) => work(tx) };
    const service = new PlatformBillingService(prisma, config, access, {}, {}, {}, realSchedule);
    const data = { orderCode: 789, amount: 499000 };
    await service.webhook({ code: '00', success: true, data, signature: payosSignature(data, 'platform-checksum') });
    assert.equal(updated.planId, 'basic-id');
    assert.equal(updated.pendingPlanId, 'standard-id');
    assert.equal(updated.nextPlanId, null);
    assert.equal(updated.pendingStartsAt.getTime(), currentExpiry.getTime());
    assert.ok(updated.expiresAt > currentExpiry);
    assert.equal(checkoutStatus, 'PAID');
    // Paying early records the next period but does not start it (no keep list applied yet).
    const period = ledger.periods.at(-1);
    assert.equal(period.planId, 'standard-id');
    assert.equal(period.startsAt.getTime(), currentExpiry.getTime());
    assert.equal(period.branchLimit, 6);
    assert.equal(period.appliedAt, null);
  });

  it('starts a late renewal from the payment time, not from the invoice period (BR-70)', async () => {
    const expired = new Date(Date.now() - 5 * 86_400_000);
    const checkout = { id: 'late-renewal', providerOrderCode: '790', chainId: 'chain-1', planId: 'basic-id', amount: new Prisma.Decimal(299000), status: 'PENDING', invoiceId: 'invoice-late' };
    const invoice = { id: 'invoice-late', status: 'PENDING', planName: 'Cơ bản', periodStartsAt: expired, periodEndsAt: new Date(expired.getTime() + 30 * 86_400_000), lines: [{ kind: 'PLAN', description: 'Gói Cơ bản', quantity: 1, unitPrice: 299000, amount: 299000 }] };
    let updated;
    let checkoutStatus = 'PENDING';
    const tx = {
      ...periodTx(),
      $executeRaw: async () => 1,
      subscriptionCheckout: { findUniqueOrThrow: async () => ({ ...checkout, status: checkoutStatus }), update: async ({ data }) => { checkoutStatus = data.status; } },
      subscriptionInvoice: { findUnique: async () => invoice, update: async () => ({}) },
      businessSubscription: { findUnique: async () => ({ id: 'sub-late', chainId: 'chain-1', planId: 'basic-id', nextPlanId: null, plan: { code: 'BASIC' }, status: 'EXPIRED', monthlyPrice: new Prisma.Decimal(299000), startsAt: new Date(expired.getTime() - 30 * 86_400_000), expiresAt: expired, trialStartedAt: null, trialConvertedAt: null, activeExtraBranches: 0, activeAccountPacks: 0, nextKeepBranchIds: null, nextKeepAccountIds: null }), update: async ({ data }) => { updated = data; } },
      businessSubscriptionEvent: { create: async () => ({}) },
      servicePlan: { findUniqueOrThrow: async () => paidPlan },
    };
    const prisma = { subscriptionCheckout: { findUnique: async () => checkout }, $transaction: async (work) => work(tx) };
    const service = new PlatformBillingService(prisma, config, access, {}, {}, {}, realSchedule);
    const before = Date.now();
    const data = { orderCode: 790, amount: 299000 };
    await service.webhook({ code: '00', success: true, data, signature: payosSignature(data, 'platform-checksum') });
    assert.equal(checkoutStatus, 'PAID');
    assert.ok(updated.startsAt.getTime() >= before, 'period starts at payment');
    assert.ok(updated.expiresAt.getTime() - updated.startsAt.getTime() >= 28 * 86_400_000);
    assert.equal(updated.pendingStartsAt, null);
  });

  it('automatically settles a paid checkout after trial expiry exactly once', async () => {
    let checkoutStatus = 'PENDING';
    let updated;
    let events = 0;
    const checkout = { id: 'late-1', chainId: 'chain-1', providerOrderCode: '987', paymentLinkId: 'link-987', planId: paidPlan.id, amount: new Prisma.Decimal(299000) };
    const tx = {
      ...periodTx(),
      $executeRaw: async () => 1,
      subscriptionCheckout: {
        findUniqueOrThrow: async () => ({ ...checkout, status: checkoutStatus }),
        update: async ({ data }) => { checkoutStatus = data.status; },
      },
      businessSubscription: {
        findUnique: async () => ({ ...trial, status: 'EXPIRED', expiresAt: new Date(0) }),
        update: async ({ data }) => { updated = data; },
      },
      businessSubscriptionEvent: { create: async () => { events++; } },
      servicePlan: { findUniqueOrThrow: async () => paidPlan },
    };
    const prisma = {
      subscriptionCheckout: { findMany: async () => checkoutStatus === 'PENDING' ? [checkout] : [] },
      $transaction: async (work) => work(tx),
    };
    const payos = { getPayment: async () => ({ orderCode: 987, status: 'PAID', amountPaid: 299000 }) };
    const service = new PlatformBillingService(prisma, config, access, payos, {}, {}, realSchedule);
    assert.equal(await service.reconcilePending(), 1);
    assert.equal(checkoutStatus, 'PAID');
    assert.equal(updated.status, 'ACTIVE');
    assert.equal(updated.planId, paidPlan.id);
    assert.equal(events, 1);
    assert.equal(await service.reconcilePending(), 0);
    assert.equal(events, 1);
  });
});
