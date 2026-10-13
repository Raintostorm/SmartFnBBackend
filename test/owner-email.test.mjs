import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateEnvironment } from '../dist/config/environment.validation.js';
import { PlatformAdminService } from '../dist/modules/platform-admin/platform-admin.service.js';
import { EmailOutboxService } from '../dist/modules/email/email-outbox.service.js';

const baseEnvironment = {
  DATABASE_URL: 'postgresql://localhost/test',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  JWT_REFRESH_SECRET: 'b'.repeat(32),
};

describe('Owner approval email', () => {
  it('accepts the Render variable names and uses the verified sender', () => {
    const env = validateEnvironment({
      ...baseEnvironment,
      NODE_ENV: 'production',
      ORDER_TRACKING_SECRET: 'c'.repeat(32),
      FRONTEND_URL: 'https://smartfnb.tech/',
      RESEND_API_KEY: 're_test',
    });
    assert.equal(env.PUBLIC_WEB_URL, 'https://smartfnb.tech');
    assert.equal(env.EMAIL_API_KEY, 're_test');
    assert.equal(env.EMAIL_FROM, 'Smart FnB <no-reply@mail.smartfnb.tech>');
  });

  it('sends only after approval commits and includes the FE setup path', async () => {
    let committed = false;
    let emailId;
    let payload;
    const transaction = {
      restaurantChain: { create: async () => ({ id: 'chain-1' }) },
      user: { create: async ({ data }) => ({ id: 'owner-user-1', email: data.email }) },
      owner: { create: async () => ({ id: 'owner-1' }) },
      ownerChainAssignment: { create: async () => ({}) },
      businessBranding: { create: async () => ({}) },
      businessSubscription: { create: async () => ({ id: 'subscription-1' }) },
      businessSubscriptionEvent: { create: async () => ({}) },
      passwordSetupToken: { create: async () => ({}) },
      emailOutbox: {
        create: async ({ data }) => {
          payload = data.payload;
          emailId = 'email-1';
          return { id: emailId };
        },
      },
      registrationApplication: { update: async () => ({}) },
    };
    const prisma = {
      registrationApplication: {
        findUnique: async ({ include }) =>
          include
            ? { id: 'application-1', status: 'APPROVED' }
            : {
                id: 'application-1', status: 'PENDING', requestedPlanId: null,
                representativeEmail: 'owner@example.com', representativePhone: '0900000000',
                representativeName: 'Test Owner', businessName: 'Test Business',
                taxCode: null, headquartersAddress: null,
              },
      },
      servicePlan: { findFirst: async () => ({ id: 'plan-1', monthlyPrice: 0 }) },
      role: { findUnique: async () => ({ id: 'owner-role' }) },
      user: { count: async () => 0 },
      $transaction: async (work) => {
        const result = await work(transaction);
        committed = true;
        return result;
      },
    };
    const emails = {
      deliver: async (id) => {
        assert.equal(committed, true);
        assert.equal(id, emailId);
        return 'SENT';
      },
    };
    const service = new PlatformAdminService(prisma, { hash: async () => 'hash' }, emails);
    const result = await service.approveRegistrationApplication(
      'application-1', { subscriptionMonths: 1 }, 'admin-1',
    );
    assert.equal(result.status, 'APPROVED');
    assert.equal(payload.employeeName, 'Test Owner');
    assert.equal(payload.setupPath, '/setup-password');
    assert.ok(payload.setupToken);
  });

  it('sends a one-time setup link through Resend and marks outbox SENT', async () => {
    const originalFetch = globalThis.fetch;
    let sent;
    globalThis.fetch = async (_url, options) => {
      sent = JSON.parse(options.body);
      return { ok: true };
    };
    try {
      let update;
      const email = new EmailOutboxService(
        {
          emailOutbox: {
            findUnique: async () => ({
              id: 'email-1', status: 'PENDING', recipient: 'owner@example.com',
              subject: 'Thiết lập tài khoản Owner Smart F&B',
              payload: { employeeName: 'Test Owner', setupToken: 'setup-token', setupPath: '/setup-password' },
            }),
            update: async ({ data }) => { update = data; },
          },
        },
        { get: (name) => ({
          EMAIL_API_KEY: 're_test', EMAIL_FROM: 'Smart FnB <no-reply@mail.smartfnb.tech>',
          PUBLIC_WEB_URL: 'https://smartfnb.tech',
        })[name] },
      );
      assert.equal(await email.deliver('email-1'), 'SENT');
      assert.equal(sent.from, 'Smart FnB <no-reply@mail.smartfnb.tech>');
      assert.deepEqual(sent.to, ['owner@example.com']);
      assert.match(sent.html, /https:\/\/smartfnb\.tech\/setup-password\?token=setup-token/);
      assert.equal(update.status, 'SENT');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
