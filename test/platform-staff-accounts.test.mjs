import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { it } from 'node:test';
import { PlatformStaffAccountsService } from '../dist/modules/platform-admin/platform-staff-accounts.service.js';
import { AuthService } from '../dist/modules/auth/auth.service.js';

it('invites Platform Staff by one-time email link without exposing a password or token', async () => {
  const calls = [];
  const tx = {
    user: { create: async ({ data }) => { calls.push({ user: data }); return { id: 'staff-user' }; } },
    passwordSetupToken: { create: async ({ data }) => calls.push({ token: data }) },
    emailOutbox: { create: async ({ data }) => { calls.push({ email: data }); return { id: 'mail-1' }; } },
    platformSupportAction: { create: async ({ data }) => calls.push({ audit: data }) },
  };
  const prisma = {
    role: { findUnique: async () => ({ id: 'staff-role' }) },
    user: { count: async () => 0 },
    $transaction: async (work) => { const result = await work(tx); calls.push('commit'); return result; },
  };
  const service = new PlatformStaffAccountsService(prisma, { hash: async () => 'unusable-password-hash' }, {
    deliver: async (id) => { assert.equal(id, 'mail-1'); assert.equal(calls.at(-1), 'commit'); return 'SENT'; },
  });
  const result = await service.create('STAFF@EXAMPLE.COM', 'New support agent', 'admin-1');
  const user = calls.find((call) => call.user).user;
  const token = calls.find((call) => call.token).token;
  const email = calls.find((call) => call.email).email;
  assert.equal(user.email, 'staff@example.com');
  assert.equal(user.status, 'INACTIVE');
  assert.equal(user.staffInvitationState, 'PENDING');
  assert.equal(user.passwordHash, 'unusable-password-hash');
  assert.equal(token.tokenHash, createHash('sha256').update(email.payload.setupToken).digest('hex'));
  assert.equal(email.payload.setupPath, '/setup-password');
  assert.ok(token.expiresAt.getTime() - Date.now() > 23 * 60 * 60_000);
  assert.equal(result.emailStatus, 'SENT');
  assert.equal(JSON.stringify(result).includes(email.payload.setupToken), false);
  assert.equal(calls.find((call) => call.audit).audit.action, 'CREATE_PLATFORM_STAFF');
});

it('lets Platform Staff confirm the email link and set a password without a branch', async () => {
  const current = {
    id: 'staff-user', status: 'INACTIVE', deletedAt: null,
    staffInvitationState: 'PENDING', role: { code: 'PLATFORM_STAFF' }, employee: null,
  };
  const writes = [];
  const tx = {
    $queryRaw: async () => [],
    user: { findUnique: async () => current, update: async ({ data }) => writes.push(data) },
    passwordSetupToken: { updateMany: async () => ({ count: 1 }) },
    authSession: { updateMany: async () => undefined },
    passwordSetupAttempt: { deleteMany: async () => undefined },
  };
  const prisma = {
    passwordSetupAttempt: { findUnique: async () => null },
    passwordSetupToken: { findFirst: async () => ({ id: 'token-1', userId: 'staff-user', user: current }) },
    $transaction: (work) => work(tx),
  };
  const auth = new AuthService({}, prisma, {}, { getOrThrow: () => 'test' }, { hash: async () => 'chosen-password-hash' });
  await auth.setupPassword({ token: 'x'.repeat(43), password: 'ChosenPass123' });
  assert.equal(writes[0].status, 'ACTIVE');
  assert.equal(writes[0].staffInvitationState, 'ACCEPTED');
  assert.equal(writes[0].passwordHash, 'chosen-password-hash');
  assert.equal(writes[0].mustChangePassword, false);
  assert.ok(writes[0].emailVerifiedAt instanceof Date);
});

it('rotates a pending invitation link, and refuses to send one while locked', async () => {
  const calls = [];
  const user = { id: 'staff-user', email: 'staff@example.com', status: 'INACTIVE', emailVerifiedAt: null };
  const prisma = {
    user: { findFirst: async () => user },
    $transaction: async (work) => work({
      passwordSetupToken: {
        findFirst: async () => ({ createdAt: new Date(Date.now() - 61_000) }),
        updateMany: async () => calls.push('old link invalidated'),
        create: async ({ data }) => calls.push({ token: data }),
      },
      authSession: { updateMany: async () => calls.push('sessions revoked') },
      emailOutbox: { create: async ({ data }) => { calls.push({ email: data }); return { id: 'mail-2' }; } },
      platformSupportAction: { create: async ({ data }) => calls.push({ audit: data }) },
    }),
  };
  const service = new PlatformStaffAccountsService(prisma, {}, { deliver: async () => 'SENT' });
  await service.resetPassword('staff-user', 'Resend invitation', 'admin-1');
  assert.equal(calls[0], 'old link invalidated');
  assert.equal(calls.find((call) => call.email).email.template, 'PLATFORM_STAFF_INVITATION');
  assert.equal(calls.find((call) => call.audit).audit.action, 'RESEND_PLATFORM_STAFF_INVITATION');
  user.status = 'SUSPENDED';
  await assert.rejects(service.resetPassword('staff-user', 'Resend invitation', 'admin-1'), (error) => error.getStatus?.() === 409);
});
