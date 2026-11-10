import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Prisma } from '../dist/generated/prisma/client.js';
import { PlatformAdminService } from '../dist/modules/platform-admin/platform-admin.service.js';
import { PlatformAdminAnalyticsService } from '../dist/modules/platform-billing/platform-admin-analytics.service.js';
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
      businessSubscription: {
        findMany: async () => [
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
        aggregate: async () => ({ _sum: { amount: new Prisma.Decimal(499000) } }),
        count: async () => 1,
      },
      registrationCheckout: {
        aggregate: async () => ({ _sum: { amount: new Prisma.Decimal(299000) } }),
        count: async () => 2,
      },
    };
    const result = await new PlatformAdminAnalyticsService(prisma).overview();
    assert.equal(result.registrations.PENDING, 3);
    assert.equal(result.registrations.REJECTED, 0);
    assert.deepEqual(result.businesses, { total: 4, paid: 1, trial: 1, expired: 1, suspended: 1 });
    assert.equal(result.mrr, 299000);
    assert.equal(result.revenueThisMonth, 798000);
    assert.equal(result.invoicesNeedReview, 3);
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
        ],
      },
      businessSubscriptionEvent: { count: async () => 1 },
    };
    const result = await new PlatformAdminAnalyticsService(prisma).revenue({
      from: '2026-10-01',
      to: '2026-10-31',
      groupBy: 'month',
    });
    assert.equal(result.summary.revenue, 798000);
    assert.equal(result.summary.invoiceCount, 2);
    assert.equal(result.summary.mrr, 798000);
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
      servicePlan: { findUniqueOrThrow: async () => ({ monthlyPrice: new Prisma.Decimal(499000) }) },
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
    const service = new PlatformBillingService(prisma, {}, {}, {}, {}, {});
    const result = await service.confirmCheckoutManually(
      checkout.id,
      'Đã đối chiếu sao kê PayOS',
      'admin-1',
    );
    assert.equal(result.status, 'PAID');
    assert.equal(event.changedById, 'admin-1');
    assert.equal(supportAction.action, 'CONFIRM_PLATFORM_INVOICE');
    assert.equal(supportAction.note, 'Đã đối chiếu sao kê PayOS');
  });
});
