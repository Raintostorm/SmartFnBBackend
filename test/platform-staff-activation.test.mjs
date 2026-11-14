import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { it } from 'node:test';
import { Prisma } from '../dist/generated/prisma/client.js';
import { PlatformAdminService } from '../dist/modules/platform-admin/platform-admin.service.js';
import { SubscriptionScheduleService } from '../dist/modules/subscription/subscription-schedule.service.js';

it('changes the approved plan only before the first checkout, including for an applicant-selected plan', async () => {
  const app = { id: 'app', status: 'APPROVED', requestedPlanId: 'basic', approvedPlanId: 'basic', activationTokenHash: 'old' };
  let checkout = null;
  let locked = false;
  const actions = [];
  const tx = {
    $executeRaw: async () => { locked = true; },
    registrationApplication: {
      findUnique: async () => app,
      update: async ({ data }) => Object.assign(app, data),
    },
    registrationCheckout: { findFirst: async ({ where }) => {
      assert.ok(locked);
      assert.deepEqual(where, { applicationId: app.id });
      return checkout;
    } },
    platformSupportAction: { create: async ({ data }) => actions.push(data) },
    emailOutbox: { create: async () => ({ id: 'mail' }) },
  };
  const service = new PlatformAdminService({
    registrationApplication: tx.registrationApplication,
    servicePlan: { findFirst: async ({ where }) => ({ id: where.id, name: where.id }) },
    $transaction: async work => { locked = false; return work(tx); },
  }, {}, { sealSetupToken: () => 'sealed', deliver: async () => 'SENT' });
  const change = plan => service.changeApprovedPlan(app.id, plan, 'Khách yêu cầu', 'staff');
  await change('pro');
  assert.equal(app.requestedPlanId, 'basic');
  assert.equal(app.approvedPlanId, 'pro');
  assert.notEqual(app.activationTokenHash, 'old');
  const token = app.activationTokenHash;
  for (const status of ['PENDING', 'FAILED', 'NEEDS_REVIEW', 'PAID']) {
    checkout = { id: 'invoice', status };
    await assert.rejects(() => change('basic'), e => e.getStatus() === 409);
  }
  checkout = null;
  app.status = 'ACTIVATED';
  await assert.rejects(() => change('basic'), e => e.getStatus() === 409);
  assert.equal(actions.length, 1);
  assert.equal(app.activationTokenHash, token);
});

it('activates a Basic trial once, provisions Owner after the choice, and emails only after commit', async () => {
  const token = 'a'.repeat(43);
  const hash = createHash('sha256').update(token).digest('hex');
  let status = 'APPROVED';
  let committed = false;
  let subscription;
  const periods = [];
  const app = {
    id: 'application-1', status, activationTokenHash: hash,
    activationExpiresAt: new Date(Date.now() + 86_400_000),
    approvedPlan: { id: 'basic', code: 'BASIC', name: 'Basic' },
    businessName: 'Cafe', representativeName: 'Test Owner',
    representativeEmail: 'owner@example.com', representativePhone: '0900000000',
    taxCode: null, headquartersAddress: null, reviewedById: 'staff-1',
  };
  const tx = {
    $executeRaw: async () => 1,
    registrationApplication: {
      findUniqueOrThrow: async () => ({ ...app, status }),
      update: async ({ data }) => { status = data.status; },
    },
    role: { findUnique: async () => ({ id: 'role-owner' }) },
    restaurantChain: { create: async () => ({ id: 'chain-1' }) },
    user: { create: async ({ data }) => ({ id: 'user-1', email: data.email }) },
    owner: { create: async () => ({ id: 'owner-1' }) },
    ownerChainAssignment: { create: async () => ({}) },
    businessBranding: { create: async () => ({}) },
    businessSubscription: { create: async ({ data }) => { subscription = data; return { id: 'sub-1' }; } },
    businessSubscriptionEvent: { create: async () => ({}) },
    registrationCheckout: { findFirst: async () => null },
    passwordSetupToken: { create: async () => ({}) },
    emailOutbox: { create: async ({ data }) => {
      assert.equal(data.payload.setupTokenEncrypted, 'sealed');
      assert.equal('setupToken' in data.payload, false);
      return { id: 'email-1' };
    } },
    servicePlan: {
      findUniqueOrThrow: async () => ({
        id: 'trial', code: 'TRIAL', name: 'Dùng thử', monthlyPrice: new Prisma.Decimal(0), maxBranches: 3, maxAccounts: 30,
        extraBranchAccounts: 8, extraBranchPrice: 0, extraAccountPackPrice: 0, extraBranchEnabled: false, brandingEnabled: false, multiBranchComparisonEnabled: false,
      }),
    },
      subscriptionPeriod: {
        upsert: async ({ create }) => { periods.push({ id: `p${periods.length}`, appliedAt: null, ...create }); return periods.at(-1); },
        updateMany: async ({ data }) => { Object.assign(periods.at(-1), data); return { count: 1 }; },
      },
  };
  const prisma = {
    registrationApplication: { findUnique: async () => status === 'APPROVED' ? { ...app, status } : null },
    servicePlan: {
      findUnique: async () => ({ id: 'basic', isActive: true, maxBranches: 2, maxAccounts: 10, maxTables: 20, brandingEnabled: false, multiBranchComparisonEnabled: false }),
      upsert: async () => ({ id: 'trial', monthlyPrice: new Prisma.Decimal(0) }),
    },
    $transaction: async (work) => { const result = await work(tx); committed = true; return result; },
  };
  const emails = { sealSetupToken: () => 'sealed', deliver: async (id) => { assert.equal(committed, true); assert.equal(id, 'email-1'); return 'FAILED'; } };
  const service = new PlatformAdminService(prisma, { hash: async () => 'hashed-password' }, emails, {}, {}, new SubscriptionScheduleService({}, {}, {}));
  const result = await service.activateTrial(token);
  assert.equal(result.activated, true);
  assert.equal(result.emailStatus, 'FAILED');
  assert.equal(status, 'ACTIVATED');
  assert.equal(subscription.planId, 'trial');
  assert.equal(subscription.expiresAt.getTime() - subscription.startsAt.getTime(), 14 * 86_400_000);
  // The trial period is frozen with the TRIAL limits (= BASIC) and started immediately.
  assert.equal(periods.length, 1);
  assert.equal(periods[0].source, 'TRIAL');
  assert.equal(periods[0].branchLimit, 3);
  assert.equal(periods[0].accountLimit, 30);
  assert.ok(periods[0].appliedAt);
  await assert.rejects(() => service.activateTrial(token), /invalid or expired/);
});

it('keeps the activation link when PayOS cannot verify cancellation or reports a payment during resend', async () => {
  const pending = { id: 'qr', providerOrderCode: '123', paymentLinkId: 'link' };
  const service = new PlatformAdminService({ registrationCheckout: { findFirst: async () => pending } });
  service.payosCredentials = () => ({});
  service.payos = { getPayment: async () => { throw Error('offline'); } };
  await assert.rejects(service.resendActivation('app', 'resend', 'staff'), e => e.getStatus() === 409);
  let settled;
  let reads = 0;
  service.payos = {
    getPayment: async () => ++reads === 1 ? { status: 'PENDING', amountPaid: 0 } : { status: 'PAID', amountPaid: 300000 },
    cancelPayment: async () => { throw Error('already paid'); },
  };
  service.completePaidActivation = async (...args) => { settled = args; };
  await assert.rejects(service.resendActivation('app', 'resend', 'staff'), e => e.getStatus() === 409);
  assert.deepEqual(settled, ['123', 300000]);
});
