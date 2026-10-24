import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Prisma } from '../dist/generated/prisma/client.js';
import { PlatformBillingService } from '../dist/modules/platform-billing/platform-billing.service.js';
import { payosSignature } from '../dist/modules/payos/payos-signature.js';

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
  status: 'ACTIVE',
};
const paidPlan = {
  id: 'basic-id',
  code: 'BASIC',
  isActive: true,
  monthlyPrice: new Prisma.Decimal(299000),
};

describe('Platform subscription PayOS checkout', () => {
  it('lets an expired trial Owner start a paid checkout through platform credentials', async () => {
    let paymentRequest;
    const prisma = {
      businessSubscription: { findUnique: async () => ({ ...trial, expiresAt: new Date(0) }) },
      servicePlan: { findUnique: async () => paidPlan },
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
    const service = new PlatformBillingService(prisma, config, access, payos);
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
        $queryRaw: async () => [],
        subscriptionCheckout: {
          findUniqueOrThrow: async () => checkout,
          update: async ({ data }) => { reviewStatus = data.status; },
        },
        businessSubscription: { update: async () => { activated++; } },
      }),
    };
    const service = new PlatformBillingService(prisma, config, access, {});
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
        $queryRaw: async () => [],
        subscriptionCheckout: {
          findUniqueOrThrow: async () => checkout,
          update: async ({ data }) => { reviewStatus = data.status; },
        },
        businessSubscription: { findUnique: async () => ({ ...trial, trialConvertedAt: new Date() }), update: async () => assert.fail('must not activate twice') },
      }),
    };
    const service = new PlatformBillingService(prisma, config, access, {});
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
      $queryRaw: async () => [],
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
    };
    const prisma = {
      subscriptionCheckout: { findUnique: async () => checkout },
      $transaction: async (callback) => callback(tx),
    };
    const service = new PlatformBillingService(prisma, config, access, {});
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
    assert.deepEqual(await service.webhook(payload), { success: true });
    assert.equal(events, 1);
  });
});
