import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Prisma } from '../dist/generated/prisma/client.js';
import { PlatformAdminService } from '../dist/modules/platform-admin/platform-admin.service.js';
import { PlatformAdminAnalyticsService } from '../dist/modules/platform-billing/platform-admin-analytics.service.js';
import { SubscriptionScheduleService } from '../dist/modules/subscription/subscription-schedule.service.js';
import { PlatformBillingService } from '../dist/modules/platform-billing/platform-billing.service.js';

describe('Platform Admin analytics', () => {
  it('returns exact KPIs without scanning restaurant orders', async () => {
    const prisma = {
      registrationApplication: {
        groupBy: async () => [
          { status: 'PENDING', _count: { _all: 3 } },
          { status: 'APPROVED', _count: { _all: 2 } },
        ],
      },
      // MRR now comes from the period snapshots covering "now" (30.4), including add-ons.
      subscriptionPeriod: {
        findMany: async () => [
          { subscriptionId: 's-basic', monthlyPrice: 299000, extraBranches: 1, extraBranchPrice: 150000, accountPacks: 2, accountPackPrice: 50000, subscription: { status: 'ACTIVE', suspendedAt: null } },
          { subscriptionId: 's-suspended', monthlyPrice: 499000, extraBranches: 0, extraBranchPrice: 0, accountPacks: 0, accountPackPrice: 0, subscription: { status: 'SUSPENDED', suspendedAt: new Date(Date.now() - 86_400_000) } },
        ],
      },
      businessSubscription: {
        findMany: async ({ where } = {}) => where?.periods ? [] : [
          {
            status: 'ACTIVE',
            expiresAt: new Date(Date.now() + 86_400_000),
            monthlyPrice: new Prisma.Decimal(299000),
            plan: { code: 'BASIC' },
          },
          {
            status: 'ACTIVE',
            expiresAt: new Date(Date.now() + 86_400_000),
            monthlyPrice: new Prisma.Decimal(0),
            plan: { code: 'TRIAL' },
          },
          {
            status: 'SUSPENDED',
            expiresAt: new Date(Date.now() + 86_400_000),
            monthlyPrice: new Prisma.Decimal(499000),
            plan: { code: 'STANDARD' },
          },
          {
            status: 'ACTIVE',
            expiresAt: new Date(0),
            monthlyPrice: new Prisma.Decimal(299000),
            plan: { code: 'BASIC' },
          },
        ],
      },
      servicePlan: { count: async () => 3 },
      subscriptionCheckout: {
        aggregate: async ({ where }) => {
          if (where.status === 'PAID') monthStarts.push(where.paidAt.gte);
          return where.status === 'PENDING'
            ? { _count: { _all: 2 }, _sum: { amount: new Prisma.Decimal(598000) } }
            : { _sum: { amount: new Prisma.Decimal(499000) } };
        },
        count: async () => 1,
      },
      registrationCheckout: {
        aggregate: async ({ where }) =>
          where.status === 'PENDING'
            ? { _count: { _all: 1 }, _sum: { amount: new Prisma.Decimal(299000) } }
            : { _sum: { amount: new Prisma.Decimal(299000) } },
        count: async () => 2,
      },
    };
    const monthStarts = [];
    const result = await new PlatformAdminAnalyticsService(prisma).overview();
    assert.equal(result.registrations.PENDING, 3);
    assert.equal(result.registrations.REJECTED, 0);
    assert.deepEqual(result.businesses, { total: 4, paid: 1, trial: 1, expired: 1, suspended: 1 });
    // 299k plan + 1 extra branch (150k) + 2 account packs (2 × 50k); the suspended business is excluded.
    assert.equal(result.mrr, 549000);
    assert.equal(result.revenueThisMonth, 798000);
    assert.equal(result.invoicesNeedReview, 3);
    // Unpaid invoices (renewal + first period) shown on the overview as work to follow up.
    assert.equal(result.unpaidInvoices, 3);
    assert.equal(result.outstandingAmount, 897000);
    // "Doanh thu tháng này" starts at 00:00 on the 1st in Vietnam time (17:00 UTC the day before).
    const vn = new Date(Date.now() + 7 * 3_600_000);
    assert.equal(monthStarts[0].toISOString(), new Date(Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth(), 1) - 7 * 3_600_000).toISOString());
    assert.equal(monthStarts[0].getUTCHours(), 17);
    assert.equal(prisma.order, undefined);
  });

  it('combines activation and renewal payments into subscription-only revenue', async () => {
    const paidAt = new Date('2026-10-15T03:00:00.000Z');
    const prisma = {
      subscriptionCheckout: {
        findMany: async ({ where }) =>
          where.status === 'PAID'
            ? [
                {
                  id: 'sub-pay',
                  chainId: 'chain-1',
                  amount: new Prisma.Decimal(499000),
                  paidAt,
                  chain: { name: 'Coffee A' },
                  plan: { id: 'standard', name: 'Tiêu chuẩn' },
                },
              ]
            : [{ amount: new Prisma.Decimal(499000), status: 'PENDING' }],
      },
      registrationCheckout: {
        findMany: async ({ where }) =>
          where.status === 'PAID'
            ? [
                {
                  id: 'first-pay',
                  amount: new Prisma.Decimal(299000),
                  paidAt,
                  application: { businessName: 'Coffee B', approvedChainId: 'chain-2' },
                  plan: { id: 'basic', name: 'Cơ bản' },
                },
              ]
            : [{ amount: new Prisma.Decimal(299000), status: 'NEEDS_REVIEW' }],
      },
      businessSubscription: {
        findMany: async () => [
          {
            status: 'ACTIVE',
            expiresAt: new Date('2027-01-01'),
            monthlyPrice: new Prisma.Decimal(499000),
            trialStartedAt: null,
            trialConvertedAt: null,
            plan: { code: 'STANDARD' },
          },
          {
            status: 'ACTIVE',
            expiresAt: new Date('2027-01-01'),
            monthlyPrice: new Prisma.Decimal(299000),
            trialStartedAt: new Date('2026-09-01'),
            trialConvertedAt: paidAt,
            plan: { code: 'BASIC' },
          },
          // October trial cohort: one converted, one still in trial, one ended without paying.
          { status: 'ACTIVE', expiresAt: new Date('2027-01-01'), monthlyPrice: new Prisma.Decimal(299000), trialStartedAt: new Date('2026-10-05T03:00:00Z'), trialEndsAt: new Date('2026-10-19T03:00:00Z'), trialConvertedAt: new Date('2026-10-18T03:00:00Z'), plan: { code: 'BASIC' } },
          { status: 'ACTIVE', expiresAt: new Date('2099-01-01'), monthlyPrice: new Prisma.Decimal(0), trialStartedAt: new Date('2026-10-30T03:00:00Z'), trialEndsAt: new Date('2099-01-01T00:00:00Z'), trialConvertedAt: null, plan: { code: 'TRIAL' } },
          { status: 'EXPIRED', expiresAt: new Date('2026-10-24T03:00:00Z'), monthlyPrice: new Prisma.Decimal(0), trialStartedAt: new Date('2026-10-10T03:00:00Z'), trialEndsAt: new Date('2026-10-24T03:00:00Z'), trialConvertedAt: null, plan: { code: 'TRIAL' } },
        ],
      },
      subscriptionPeriod: {
        findMany: async ({ where }) => {
          mrrWhere = where;
          return [
            { subscriptionId: 's1', monthlyPrice: 499000, extraBranches: 0, extraBranchPrice: 0, accountPacks: 0, accountPackPrice: 0, subscription: { status: 'ACTIVE', suspendedAt: null } },
            { subscriptionId: 's2', monthlyPrice: 299000, extraBranches: 0, extraBranchPrice: 0, accountPacks: 0, accountPackPrice: 0, subscription: { status: 'ACTIVE', suspendedAt: null } },
          ];
        },
      },
      businessSubscriptionEvent: { count: async () => 1 },
    };
    let mrrWhere;
    const result = await new PlatformAdminAnalyticsService(prisma).revenue({
      from: '2026-10-01',
      to: '2026-10-31',
      groupBy: 'month',
    });
    assert.equal(result.summary.revenue, 798000);
    assert.equal(result.summary.invoiceCount, 2);
    assert.equal(result.summary.mrr, 798000);
    // A past range reads MRR at its last instant (31/10 23:59:59 Vietnam time), not "now".
    assert.equal(mrrWhere.startsAt.lte.toISOString(), '2026-10-31T16:59:59.999Z');
    assert.equal(result.summary.mrrAt, '2026-10-31T16:59:59.999Z');
    // Cohort by trial START month; the September trial is outside the range.
    assert.deepEqual(result.trialCohorts, [{ month: '2026-10', started: 3, converted: 1, inTrial: 1, conversionRate: 1 / 3, settledConversionRate: 0.5 }]);
    assert.equal(result.summary.trialConversionRate, 1 / 3);
    assert.equal(result.summary.trialInProgress, 1);
    assert.equal(result.summary.unpaidInvoices, 1);
    assert.equal(result.summary.reviewInvoices, 1);
    assert.equal(result.summary.manualRenewals, 1);
    assert.deepEqual(result.series, [{ period: '2026-10', revenue: 798000, invoiceCount: 2 }]);
  });
});

describe('Platform Admin invoice reconciliation', () => {
  it('confirms a reviewed first invoice once, provisions the Owner and records the audit note', async () => {
    let status = 'NEEDS_REVIEW';
    let supportAction;
    let deliveredEmailId;
    const application = {
      id: 'application-1',
      status: 'APPROVED',
      approvedPlanId: 'basic',
    };
    const checkout = {
      id: 'checkout-registration-1',
      applicationId: application.id,
      planId: 'basic',
      status,
      reviewReason: 'SIGNED_AMOUNT_MISMATCH',
    };
    const tx = {
      $queryRaw: async () => [],
      $executeRaw: async () => 1,
      registrationCheckout: {
        findUnique: async () => ({ ...checkout, status }),
        update: async ({ data }) => {
          status = data.status;
        },
      },
      registrationApplication: { findUnique: async () => application },
      servicePlan: {
        findUniqueOrThrow: async () => ({ id: 'basic', monthlyPrice: new Prisma.Decimal(299000) }),
      },
      platformSupportAction: {
        create: async ({ data }) => {
          supportAction = data;
        },
      },
    };
    const prisma = {
      $transaction: async (work) => work(tx),
      registrationCheckout: {
        findUniqueOrThrow: async () => ({
          id: checkout.id,
          status,
          paidAt: new Date(),
          reviewReason: checkout.reviewReason,
        }),
      },
    };
    const emails = {
      deliver: async (id) => {
        deliveredEmailId = id;
      },
    };
    const service = new PlatformAdminService(prisma, {}, emails, {}, {});
    service.provisionRegistration = async () => 'owner-email-1';

    const result = await service.confirmRegistrationCheckoutManually(
      checkout.id,
      'Đã kiểm tra giao dịch kỳ đầu',
      'admin-1',
    );

    assert.equal(result.status, 'PAID');
    assert.equal(deliveredEmailId, 'owner-email-1');
    assert.equal(supportAction.actorUserId, 'admin-1');
    assert.equal(supportAction.action, 'CONFIRM_REGISTRATION_INVOICE');
    assert.equal(supportAction.note, 'Đã kiểm tra giao dịch kỳ đầu');
  });

  it('confirms a reviewed recurring invoice once and writes an audit action', async () => {
    let status = 'NEEDS_REVIEW';
    let event;
    let supportAction;
    const periods = [];
    const checkout = {
      id: 'checkout-1',
      chainId: 'chain-1',
      planId: 'standard',
      amount: new Prisma.Decimal(499000),
      reviewReason: 'SIGNED_AMOUNT_MISMATCH',
      status,
    };
    const tx = {
      $queryRaw: async () => [],
      $executeRaw: async () => 1,
      subscriptionCheckout: {
        findUnique: async () => ({ ...checkout, status }),
        update: async ({ data }) => {
          status = data.status;
        },
      },
      businessSubscription: {
        findUnique: async () => ({
          id: 'sub-1',
          chainId: 'chain-1',
          startsAt: new Date(Date.now() - 29 * 86_400_000),
          planId: 'basic',
          nextPlanId: 'standard',
          plan: { code: 'BASIC' },
          status: 'ACTIVE',
          monthlyPrice: new Prisma.Decimal(299000),
          expiresAt: new Date(Date.now() + 86_400_000),
          trialStartedAt: null,
          trialConvertedAt: null,
        }),
        update: async () => ({}),
      },
      businessSubscriptionEvent: {
        create: async ({ data }) => {
          event = data;
        },
      },
      servicePlan: {
        findUniqueOrThrow: async () => ({
          id: 'standard', code: 'STANDARD', name: 'Tiêu chuẩn', monthlyPrice: new Prisma.Decimal(499000),
          maxBranches: 6, maxAccounts: 55, extraBranchAccounts: 8, extraBranchPrice: 220000, extraAccountPackPrice: 50000,
          extraBranchEnabled: true, brandingEnabled: true, multiBranchComparisonEnabled: true,
        }),
      },
      subscriptionPeriod: {
        upsert: async ({ create }) => { periods.push({ id: `p${periods.length}`, appliedAt: null, ...create }); return periods.at(-1); },
        updateMany: async ({ data }) => { Object.assign(periods.at(-1), data); return { count: 1 }; },
      },
      ownerChainAssignment: { findMany: async () => [] },
      platformSupportAction: {
        create: async ({ data }) => {
          supportAction = data;
        },
      },
    };
    const prisma = {
      $transaction: async (work) => work(tx),
      subscriptionCheckout: {
        findUniqueOrThrow: async () => ({
          id: checkout.id,
          status,
          paidAt: new Date(),
          reviewReason: checkout.reviewReason,
        }),
      },
    };
    const service = new PlatformBillingService(prisma, {}, {}, {}, {}, {}, new SubscriptionScheduleService({}, {}, {}));
    const result = await service.confirmCheckoutManually(
      checkout.id,
      'Đã đối chiếu sao kê PayOS',
      'admin-1',
    );
    assert.equal(result.status, 'PAID');
    assert.equal(event.changedById, 'admin-1');
    assert.equal(supportAction.action, 'CONFIRM_PLATFORM_INVOICE');
    assert.equal(supportAction.note, 'Đã đối chiếu sao kê PayOS');
    // Manual confirmation records the same frozen period as the webhook; early → not started yet.
    assert.equal(periods.length, 1);
    assert.equal(periods[0].source, 'MANUAL_CONFIRMATION');
    assert.equal(periods[0].branchLimit, 6);
    assert.equal(periods[0].appliedAt, null);
  });
});
