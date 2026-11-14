import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PasswordResetService } from '../dist/modules/auth/password-reset.service.js';
import { AuthService } from '../dist/modules/auth/auth.service.js';
import { EmailOutboxService } from '../dist/modules/email/email-outbox.service.js';

const now = new Date();
const metadata = { ipAddress: '127.0.0.1', userAgent: 'test' };
const events = () => { const published = []; return { published, publish: (event) => published.push(event) }; };

test('unknown and Platform Admin emails receive the same public response without creating a request', async () => {
  const created = [];
  let user = null;
  const prisma = {
    $transaction: (run) => run({ $queryRaw: async () => 1, passwordResetAttempt: { count: async () => 0, create: async () => ({}) } }),
    user: { findFirst: async () => user },
    passwordResetRequest: { create: async (input) => created.push(input) },
  };
  const service = new PasswordResetService(prisma, {}, {}, events());
  const unknown = await service.request('unknown@example.com', metadata);
  user = { status: 'ACTIVE', role: { code: 'ADMIN' }, staffInvitationState: null };
  const admin = await service.request('admin@example.com', metadata);
  assert.deepEqual(unknown, admin);
  assert.equal(created.length, 0);
});

test('Store Manager creates one request in the Brand Manager chain room', async () => {
  const published = events();
  const created = [];
  const prisma = {
    $transaction: (run) => run({
      $queryRaw: async () => 1,
      passwordResetAttempt: { count: async () => 0, create: async () => ({}) },
      passwordResetRequest: {
        updateMany: async () => ({ count: 0 }),
        findFirst: async () => null,
        create: async ({ data }) => { created.push(data); return { id: 'request-1' }; },
      },
      passwordResetAudit: { create: async () => ({}) },
    }),
    user: { findFirst: async () => ({ id: 'manager-1', email: 'manager@example.com', status: 'ACTIVE', staffInvitationState: 'ACCEPTED', role: { code: 'MANAGER' }, employee: { branch: { chainId: 'chain-1' } } }) },
  };
  const service = new PasswordResetService(prisma, {}, {}, published);
  await service.request('manager@example.com', metadata);
  assert.equal(created[0].scopeChainId, 'chain-1');
  assert.deepEqual(published.published, [{ type: 'password-reset.requested', chainId: 'chain-1', requestId: 'request-1' }]);
});

test('Cashier receives a 30-minute self-reset link without invalidating current sessions', async () => {
  const writes = [];
  const prisma = {
    $transaction: (run) => run({
      $queryRaw: async () => 1,
      $queryRaw: async () => [],
      passwordResetAttempt: { count: async () => 0, create: async () => ({}) },
      user: { findUnique: async () => ({ status: 'ACTIVE', staffInvitationState: 'ACCEPTED' }) },
      passwordSetupToken: { findFirst: async () => null, count: async () => 0, updateMany: async ({ data }) => writes.push({ cancelled: data }), create: async ({ data }) => writes.push({ token: data }) },
      emailOutbox: { create: async ({ data }) => { writes.push({ mail: data }); return { id: 'email-1' }; } },
      passwordResetAudit: { create: async () => ({}) },
    }),
    user: { findFirst: async () => ({ id: 'cashier-1', email: 'cashier@example.com', status: 'ACTIVE', staffInvitationState: 'ACCEPTED', role: { code: 'CASHIER' } }) },
    passwordSetupToken: { findFirst: async () => null, count: async () => 0 },
  };
  const delivered = [];
  const service = new PasswordResetService(prisma, {}, { sealSetupToken: (token) => `sealed:${token}`, deliver: async (id) => delivered.push(id) }, events());
  await service.request('cashier@example.com', metadata);
  assert.equal(writes.find((write) => write.token).token.purpose, 'SELF_RESET');
  assert.ok(writes.find((write) => write.token).token.expiresAt > now);
  assert.equal(writes.find((write) => write.mail).mail.recipient, 'cashier@example.com');
  assert.deepEqual(delivered, ['email-1']);
  assert.equal(writes.some((write) => write.session), false);
});

test('sixth request from one IP is rate limited without account lookup', async () => {
  let lookedUp = false;
  const prisma = {
    $transaction: (run) => run({ $queryRaw: async () => 1, passwordResetAttempt: { count: async () => 5 } }),
    user: { findFirst: async () => { lookedUp = true; return null; } },
  };
  const service = new PasswordResetService(prisma, {}, {}, events());
  await assert.rejects(service.request('any@example.com', metadata), (error) => error.getStatus?.() === 429);
  assert.equal(lookedUp, false);
});

test('out-of-scope reset returns 404; authorized approval invalidates old credentials and mails once', async () => {
  const writes = [];
  const eventBus = events();
  const item = { id: 'request-1', userId: 'owner-1', scopeChainId: 'chain-1', status: 'PENDING', expiresAt: new Date(Date.now() + 60_000), handledBy: null,
    user: { email: 'owner@example.com', status: 'ACTIVE', staffInvitationState: null, role: { code: 'OWNER' } } };
  const tx = {
    $queryRaw: async () => [],
    passwordResetRequest: { findUnique: async () => item, update: async ({ data }) => writes.push({ request: data }) },
    passwordSetupToken: { updateMany: async ({ data }) => writes.push({ cancelled: data }), create: async ({ data }) => writes.push({ token: data }) },
    user: { update: async ({ data }) => writes.push({ user: data }) },
    authSession: { updateMany: async ({ data }) => writes.push({ session: data }) },
    emailOutbox: { create: async ({ data }) => { writes.push({ email: data }); return { id: 'mail-1' }; } },
    passwordResetAudit: { create: async () => ({}) },
  };
  const prisma = { passwordResetRequest: { updateMany: async () => ({ count: 0 }), findMany: async () => [] }, $transaction: (run) => run(tx) };
  const sent = [];
  const service = new PasswordResetService(prisma, { hash: async () => 'invalid-hash' }, { sealSetupToken: (token) => `sealed:${token}`, deliver: async (id) => sent.push(id) }, eventBus);
  const cashier = { id: 'cashier-2', role: 'CASHIER', chainIds: [], branchId: 'branch-2' };
  await assert.rejects(service.resolve(cashier, item.id), (error) => error.getStatus?.() === 404);
  assert.equal(writes.length, 0);
  const staff = { id: 'staff-1', role: 'PLATFORM_STAFF', chainIds: [] };
  await service.resolve(staff, item.id);
  assert.equal(writes.find((write) => write.request).request.status, 'RESET');
  assert.equal(writes.find((write) => write.user).user.status, 'INACTIVE');
  assert.equal(writes.find((write) => write.token).token.purpose, 'SUPERIOR_RESET');
  assert.equal(writes.find((write) => write.email).email.recipient, 'owner@example.com');
  assert.equal(writes.find((write) => write.session).session.revokedAt instanceof Date, true);
  assert.deepEqual(sent, ['mail-1']);
  assert.deepEqual(eventBus.published, [{ type: 'password-reset.resolved', chainId: null, requestId: item.id }]);
});

test('Cashier self-reset keeps old password until confirmation, then revokes sessions and records method', async () => {
  const writes = [];
  const current = { id: 'cashier-1', email: 'cashier@example.com', passwordHash: 'old-hash', status: 'ACTIVE', deletedAt: null,
    staffInvitationState: 'ACCEPTED', role: { code: 'CASHIER' }, employee: { id: 'employee-1', branchId: 'branch-1', branch: { chain: { subscription: null } } } };
  const tx = {
    $queryRaw: async () => [],
    user: { findUnique: async () => current, update: async ({ data }) => writes.push({ user: data }) },
    passwordSetupToken: { updateMany: async ({ data }) => { writes.push({ token: data }); return { count: 1 }; } },
    authSession: { updateMany: async ({ data }) => writes.push({ session: data }) },
    passwordSetupAttempt: { deleteMany: async () => undefined },
    branchAuditLog: { create: async () => undefined },
    passwordResetAudit: { create: async () => undefined },
  };
  const prisma = {
    passwordSetupAttempt: { findUnique: async () => null },
    passwordSetupToken: { findFirst: async () => ({ id: 'link-1', userId: current.id, purpose: 'SELF_RESET', user: { ...current, employee: { branch: { chainId: 'chain-1' } } } }) },
    $transaction: (run) => run(tx),
  };
  const auth = new AuthService({}, prisma, {}, { getOrThrow: () => 'test' }, { hash: async () => 'new-hash', verify: async () => false });
  assert.equal(writes.length, 0);
  await auth.setupPassword({ token: 'x'.repeat(43), password: 'NewPassword123' });
  assert.equal(writes.find((write) => write.user).user.lastPasswordChangeMethod, 'SELF_RESET');
  assert.equal(writes.find((write) => write.user).user.passwordHash, 'new-hash');
  assert.equal(writes.find((write) => write.session).session.revokedAt instanceof Date, true);
});

test('another handler sees the first handler name on a concurrent reset', async () => {
  const item = { status: 'RESET', scopeChainId: 'chain-1', user: { role: { code: 'MANAGER' } }, handledBy: { email: 'owner@example.com', role: { code: 'OWNER' }, owner: { firstName: 'Minh', lastName: 'Nguyen' }, employee: null } };
  const service = new PasswordResetService({
    passwordResetRequest: { findMany: async () => [] },
    $transaction: async (work) => work({ $queryRaw: async () => [], passwordResetRequest: { findUnique: async () => item } }),
  }, { hash: async () => 'unused' }, {}, events());
  await assert.rejects(service.resolve({ id: 'owner-2', role: 'OWNER', chainIds: ['chain-1'] }, 'request-id'), (error) => error.getStatus?.() === 409 && /Minh Nguyen/.test(error.message) && !/owner@example.com/.test(error.message));
});

test('queued password links contain authenticated ciphertext instead of the raw token', () => {
  const service = new EmailOutboxService({}, { getOrThrow: () => 'refresh-secret-for-test'.repeat(2) });
  const token = 'once-only-secret-token';
  const sealed = service.sealSetupToken(token);
  assert.equal(sealed.includes(token), false);
  assert.equal(service.readSetupToken({ setupTokenEncrypted: sealed }), token);
});

test('email delivery persists the account status and removes the queued token', async () => {
  const originalFetch = globalThis.fetch;
  const accountStatuses = [];
  let outboxUpdate;
  let payload;
  const config = { getOrThrow: () => 'refresh-secret-for-test'.repeat(2), get: (key) => ({ EMAIL_API_KEY: 'test-api-key', EMAIL_FROM: 'test@example.com', PUBLIC_WEB_URL: 'https://smartfnb.tech' })[key] };
  const service = new EmailOutboxService({
    emailOutbox: { findUnique: async () => ({ id: 'mail-1', status: 'PENDING', recipient: 'cashier@example.com', subject: 'Reset', template: 'STAFF_ACCOUNT_CREATED', payload }), update: async ({ data }) => { outboxUpdate = data; } },
    user: { updateMany: async ({ data }) => accountStatuses.push(data.emailSendStatus) },
  }, config);
  payload = { setupTokenEncrypted: service.sealSetupToken('secret-token'), setupPath: '/setup-password' };
  globalThis.fetch = async () => ({ ok: true });
  try {
    assert.equal(await service.deliver('mail-1'), 'SENT');
    assert.deepEqual(accountStatuses, ['PENDING', 'SENT']);
    assert.equal(outboxUpdate.payload.setupTokenEncrypted, undefined);
    assert.ok(outboxUpdate.sentAt instanceof Date);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Platform Staff pending list and badge include only live Owner requests even beyond the history limit', async () => {
  const queries = [];
  const service = new PasswordResetService({ passwordResetRequest: {
    findMany: async args => { queries.push(args); return []; },
    count: async args => { queries.push(args); return 137; },
  } }, {}, {}, events());
  const actor = { role: 'PLATFORM_STAFF' };
  await service.list(actor, true);
  const pending = queries.at(-1);
  assert.equal(pending.take, undefined);
  assert.equal(pending.where.status, 'PENDING');
  assert.equal(pending.where.user.role.code, 'OWNER');
  assert.ok(pending.where.expiresAt.gt instanceof Date);
  assert.deepEqual(await service.count(actor), { count: 137 });
  assert.deepEqual(queries.at(-1).where.user, pending.where.user);
  await service.list(actor);
  assert.equal(queries.at(-1).take, 100);
});
