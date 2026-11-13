import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ValidationPipe } from '@nestjs/common';
import { ROLES_KEY } from '../dist/modules/auth/auth.constants.js';
import { PasswordResetService } from '../dist/modules/auth/password-reset.service.js';
import { ProfileService } from '../dist/modules/auth/profile.service.js';
import { UpdateProfileDto } from '../dist/modules/auth/dto/profile.dto.js';
import { PlatformStaffController } from '../dist/modules/platform-admin/platform-staff.controller.js';
import { PlatformAdminService } from '../dist/modules/platform-admin/platform-admin.service.js';
import { EmployeesController } from '../dist/modules/employees/employees.controller.js';
import { CombosService } from '../dist/modules/menu/combos.service.js';
import { MenuExtrasService } from '../dist/modules/menu/menu-extras.service.js';
import { MenuService } from '../dist/modules/menu/menu.service.js';
import { DisplayPostersService } from '../dist/modules/branding/display-posters.service.js';
import { Prisma } from '../dist/generated/prisma/client.js';

const staff = { id: 'staff-1', role: 'PLATFORM_STAFF', chainIds: [] };
const admin = { id: 'admin-1', role: 'ADMIN', chainIds: [] };
const owner = { id: 'owner-user', role: 'OWNER', chainIds: ['chain-1'], ownerId: 'owner-1' };

// ---------- 6. Platform Staff direct reset of a Brand Manager (PS-01, BR-56) ----------

function resetFixture({ ownerRow, pending = [{ id: 'req-1' }] } = {}) {
  const writes = [];
  const published = [];
  const sent = [];
  const row = ownerRow === undefined
    ? { id: 'owner-1', userId: 'owner-user', chainAssignments: [{ chainId: 'chain-1' }], user: { email: 'bm@example.com', status: 'ACTIVE', staffInvitationState: null, role: { code: 'OWNER' } } }
    : ownerRow;
  const tx = {
    $queryRaw: async () => [],
    owner: { findFirst: async ({ where }) => { writes.push({ ownerLookup: where }); return row; } },
    passwordSetupToken: {
      findFirst: async () => null,
      updateMany: async ({ where, data }) => writes.push({ cancel: { where, data } }),
      create: async ({ data }) => writes.push({ token: data }),
    },
    passwordResetRequest: {
      findMany: async () => pending,
      updateMany: async ({ where, data }) => { writes.push({ closeRequests: { where, data } }); return { count: pending.length }; },
    },
    user: { update: async ({ where, data }) => writes.push({ user: { where, data } }) },
    authSession: { updateMany: async ({ where, data }) => writes.push({ sessions: { where, data } }) },
    emailOutbox: { create: async ({ data }) => { writes.push({ email: data }); return { id: 'mail-1' }; } },
    passwordResetAudit: { create: async ({ data }) => writes.push({ resetAudit: data }) },
    platformSupportAction: { create: async ({ data }) => writes.push({ support: data }) },
  };
  const service = new PasswordResetService(
    { $transaction: (run) => run(tx) },
    { hash: async () => 'unusable-hash' },
    { sealSetupToken: (token) => `sealed:${token}`, deliver: async (id) => { sent.push(id); return 'SENT'; } },
    { publish: (event) => published.push(event) },
  );
  return { service, writes, published, sent };
}

test('Platform Staff resets a Brand Manager: old password and sessions revoked, old links cancelled, one email to the BM', async () => {
  const { service, writes, published, sent } = resetFixture();
  const result = await service.resetBrandManager(staff, 'owner-1', 'Đã gọi xác minh qua số đăng ký', { ipAddress: '203.0.113.5' });
  assert.equal(writes.find((w) => w.ownerLookup).ownerLookup.user.role.code, 'OWNER');
  assert.deepEqual(writes.find((w) => w.cancel).cancel.where, { userId: 'owner-user', usedAt: null, cancelledAt: null });
  assert.equal(writes.find((w) => w.token).token.purpose, 'SUPERIOR_RESET');
  assert.equal(writes.find((w) => w.token).token.tokenHash.length, 64);
  const user = writes.find((w) => w.user).user;
  assert.deepEqual([user.where.id, user.data.passwordHash, user.data.status], ['owner-user', 'unusable-hash', 'INACTIVE']);
  assert.equal(writes.find((w) => w.sessions).sessions.where.userId, 'owner-user');
  const emails = writes.filter((w) => w.email);
  assert.equal(emails.length, 1);
  assert.equal(emails[0].email.recipient, 'bm@example.com');
  assert.equal(JSON.stringify(emails[0].email.payload).includes('unusable-hash'), false);
  const audit = writes.find((w) => w.resetAudit && w.resetAudit.event === 'SUPERIOR_RESET_REQUESTED').resetAudit;
  assert.deepEqual([audit.actorUserId, audit.subjectUserId, audit.ipAddress], ['staff-1', 'owner-user', '203.0.113.5']);
  const support = writes.find((w) => w.support).support;
  assert.equal(support.action, 'RESET_BRAND_MANAGER_PASSWORD');
  assert.equal(support.note, 'Đã gọi xác minh qua số đăng ký');
  assert.equal(support.chainId, 'chain-1');
  assert.equal(support.details.ipAddress, '203.0.113.5');
  assert.equal(JSON.stringify(support).includes('sealed:'), false, 'no link token in audit');
  assert.equal(writes.find((w) => w.closeRequests).closeRequests.data.status, 'RESET');
  assert.deepEqual(published, [{ type: 'password-reset.resolved', chainId: null, requestId: 'req-1' }]);
  assert.deepEqual(sent, ['mail-1']);
  assert.equal(result.recipient, 'bm@example.com');
  assert.equal('token' in result, false);
});

test('Platform Admin inherits the reset; other roles, empty notes, non-BM targets and locked BMs are refused', async () => {
  await resetFixture().service.resetBrandManager(admin, 'owner-1', 'Admin hỗ trợ thay Staff');
  for (const actor of [owner, { id: 'm', role: 'MANAGER', chainIds: [] }]) {
    await assert.rejects(resetFixture().service.resetBrandManager(actor, 'owner-1', 'ghi chú hợp lệ'), (e) => e.getStatus?.() === 403);
  }
  await assert.rejects(resetFixture().service.resetBrandManager(staff, 'owner-1', '  '), (e) => e.getStatus?.() === 400);
  const missing = resetFixture({ ownerRow: null });
  await assert.rejects(missing.service.resetBrandManager(staff, 'manager-owner-id', 'ghi chú hợp lệ'), (e) => e.getStatus?.() === 404);
  assert.equal(missing.writes.some((w) => w.user || w.email), false);
  const locked = resetFixture({ ownerRow: { id: 'owner-1', userId: 'owner-user', chainAssignments: [], user: { email: 'bm@example.com', status: 'SUSPENDED', staffInvitationState: null, role: { code: 'OWNER' } } } });
  await assert.rejects(locked.service.resetBrandManager(staff, 'owner-1', 'ghi chú hợp lệ'), (e) => e.getStatus?.() === 403);
  assert.equal(locked.writes.some((w) => w.email), false);
});

test('direct reset route is on the Platform Staff controller (Admin inherits) and the direct password route is gone', () => {
  assert.deepEqual(Reflect.getMetadata(ROLES_KEY, PlatformStaffController), ['PLATFORM_STAFF']);
  assert.equal(typeof PlatformStaffController.prototype.resetOwnerPassword, 'function');
  assert.equal(typeof PlatformStaffController.prototype.awaitingActivation, 'function');
  assert.equal(EmployeesController.prototype.setPassword, undefined);
  assert.equal(typeof EmployeesController.prototype.attachLegacyEmail, 'function');
});

// ---------- 8. BR-06 audit ----------

function auditTx(extra = {}) {
  const audits = [];
  return { audits, tx: { chainAuditLog: { create: async ({ data }) => { audits.push(data); return data; } }, ...extra } };
}

test('combo create and disable write a chain audit row with before/after in the same transaction', async () => {
  const stored = { id: 'combo-1', chainId: 'chain-1', categoryId: 'cat', name: 'Combo sáng', price: new Prisma.Decimal(50000), isActive: true, description: null, imageUrl: null, displayOrder: 0,
    components: [
      { type: 'FIXED', name: 'Bánh', quantity: 1, fixedSizeCode: null, displayOrder: 0, choices: [{ menuItemId: 'bread', surcharge: new Prisma.Decimal(0), isDefault: true }] },
      { type: 'CHOICE', name: 'Nước', quantity: 1, fixedSizeCode: null, displayOrder: 1, choices: [{ menuItemId: 'tea', surcharge: new Prisma.Decimal(0), isDefault: true }, { menuItemId: 'matcha', surcharge: new Prisma.Decimal(5000), isDefault: false }] },
    ] };
  let current = null;
  const { audits, tx } = auditTx({
    combo: {
      findFirst: async () => current,
      create: async ({ data }) => { current = { ...stored, ...data, id: 'combo-1' }; return current; },
      update: async ({ data }) => { current = { ...current, ...data }; return current; },
      findUniqueOrThrow: async () => ({ ...stored, ...current, components: stored.components }),
    },
    menuCategory: { count: async () => 1 },
    menuItem: { findMany: async () => ['bread', 'tea', 'matcha'].map((id) => ({ id, optionGroups: [] })) },
    comboComponent: { deleteMany: async () => undefined, create: async () => undefined },
    branch: { findMany: async () => [] },
    branchCombo: { createMany: async () => undefined },
  });
  const service = new CombosService({ $transaction: (run) => run(tx), branch: { findMany: async () => [] } }, { assertCanManageChain: async () => undefined }, { branch: () => undefined });
  await service.save('chain-1', null, { categoryId: 'cat', name: 'Combo sáng', price: 50000, components: stored.components.map((c) => ({ ...c, choices: c.choices.map((x) => ({ ...x, surcharge: Number(x.surcharge) })) })) }, owner);
  assert.equal(audits[0].action, 'COMBO_CREATED');
  assert.equal(audits[0].before, undefined);
  assert.equal(audits[0].after.price, '50000');
  current = { ...stored };
  await service.save('chain-1', 'combo-1', { isActive: false }, owner);
  assert.equal(audits[1].action, 'COMBO_DISABLED');
  assert.deepEqual([audits[1].before.isActive, audits[1].after.isActive], [true, false]);
  assert.deepEqual([audits[1].actorUserId, audits[1].actorRole, audits[1].chainId], ['owner-user', 'OWNER', 'chain-1']);
});

test('topping disable, option price change and poster removal are audited once each', async () => {
  const extra = { id: 'x1', chainId: 'chain-1', name: 'Trân châu', price: new Prisma.Decimal(5000), isActive: true };
  const e = auditTx({ menuExtra: { update: async ({ data }) => ({ ...extra, ...data, price: new Prisma.Decimal(data.price) }) } });
  const extras = new MenuExtrasService({ menuExtra: { findFirst: async () => extra }, $transaction: (run) => run(e.tx), branch: { findMany: async () => [] } }, { assertCanManageChain: async () => undefined }, { branch: () => undefined });
  await extras.disable('chain-1', 'x1', owner);
  assert.deepEqual(e.audits.map((a) => a.action), ['MENU_EXTRA_DISABLED']);
  assert.deepEqual([e.audits[0].before.isActive, e.audits[0].after.isActive], [true, false]);

  const option = { id: 'o1', groupId: 'g1', code: 'L', name: 'Size L', priceDelta: new Prisma.Decimal(5000), isActive: true, isDefault: false };
  const o = auditTx({ menuOption: { update: async ({ data }) => ({ ...option, ...data, priceDelta: new Prisma.Decimal(data.priceDelta) }) } });
  const menu = new MenuService({ menuOption: { findFirst: async () => option }, $transaction: (run) => run(o.tx) }, { assertCanManageChain: async () => undefined }, { branch: () => undefined });
  await menu.updateOption('chain-1', 'g1', 'o1', { priceDelta: 8000 }, owner);
  assert.equal(o.audits.length, 1);
  assert.equal(o.audits[0].action, 'MENU_OPTION_PRICE_CHANGED');
  assert.deepEqual([o.audits[0].before.priceDelta, o.audits[0].after.priceDelta], ['5000', '8000']);

  const poster = { id: 'p1', chainId: 'chain-1', title: 'Poster', imageUrl: '/uploads/posters/a.png', enabled: true, sortOrder: 0, durationSeconds: 8 };
  const p = auditTx({ displayPoster: { findFirst: async () => poster, updateMany: async () => ({ count: 1 }) } });
  const posters = new DisplayPostersService({ $transaction: (run) => run(p.tx) }, { assertCanManageChain: async () => undefined }, { assertFeatureEnabled: async () => undefined });
  await posters.remove('chain-1', 'p1', owner);
  assert.deepEqual(p.audits.map((a) => [a.action, a.entityId]), [['POSTER_DELETED', 'p1']]);
});

test('rejecting an application writes a support audit with the reason', async () => {
  const actions = [];
  const tx = {
    registrationApplication: { updateMany: async () => ({ count: 1 }), findUniqueOrThrow: async () => ({ applicationCode: 'A1', businessName: 'Quán', representativeName: 'An', representativeEmail: 'an@example.com' }) },
    platformSupportAction: { create: async ({ data }) => actions.push(data) },
    emailOutbox: { create: async () => ({ id: 'mail-1' }) },
  };
  const service = new PlatformAdminService({ $transaction: (run) => run(tx), registrationApplication: { findUnique: async () => ({ id: 'app-1', status: 'REJECTED' }) } }, {}, { deliver: async () => 'SENT' });
  await service.rejectRegistrationApplication('app-1', '  Thiếu giấy phép kinh doanh ', 'staff-1').catch(() => undefined);
  assert.deepEqual(actions.map((a) => [a.action, a.note, a.actorUserId]), [['REJECT_APPLICATION', 'Thiếu giấy phép kinh doanh', 'staff-1']]);
});

// ---------- 9. Approved — awaiting activation (PS-01, 30.3, BR-07) ----------

test('awaiting-activation list separates "QR created" from "paid" and ignores checkouts of a previous link', async () => {
  const sentAt = new Date(Date.now() - 2 * 86_400_000);
  const rows = [
    { id: 'a1', applicationCode: 'A1', businessName: 'Quán A', representativeName: 'An', representativeEmail: 'a@example.com', representativePhone: '0900', requestedPlanId: 'basic', reviewedAt: sentAt, activationSentAt: sentAt, activationExpiresAt: new Date(sentAt.getTime() + 7 * 86_400_000), activationLastOpenedAt: new Date(),
      approvedPlan: { id: 'basic', code: 'BASIC', name: 'Cơ bản', monthlyPrice: new Prisma.Decimal(299000) },
      activationCheckouts: [
        { id: 'c2', planId: 'basic', amount: new Prisma.Decimal(299000), status: 'PENDING', checkoutUrl: 'https://pay.example/c2', paidAt: null, createdAt: new Date() },
        { id: 'c1', planId: 'basic', amount: new Prisma.Decimal(299000), status: 'PAID', checkoutUrl: 'https://pay.example/c1', paidAt: new Date(sentAt.getTime() - 1000), createdAt: new Date(sentAt.getTime() - 5000) },
      ] },
    { id: 'a2', applicationCode: 'A2', businessName: 'Quán B', representativeName: 'Bình', representativeEmail: 'b@example.com', representativePhone: '0901', requestedPlanId: 'pro', reviewedAt: sentAt, activationSentAt: null, activationExpiresAt: new Date(Date.now() - 1000), activationLastOpenedAt: null,
      approvedPlan: { id: 'pro', code: 'PRO', name: 'Pro', monthlyPrice: new Prisma.Decimal(599000) }, activationCheckouts: [] },
  ];
  let query;
  const service = new PlatformAdminService({ registrationApplication: { findMany: async (q) => { query = q; return rows; }, count: async () => 2 } }, {}, {});
  const page = await service.listAwaitingActivation({ page: 1, limit: 20 });
  assert.equal(query.where.status, 'APPROVED');
  const [a, b] = page.items;
  assert.deepEqual(a.firstPeriodQr, { created: true, createdAt: rows[0].activationCheckouts[0].createdAt, latestStatus: 'PENDING', paid: false, needsReview: false, amount: '299000' });
  assert.equal(a.linkExpired, false);
  assert.ok(a.activationLastOpenedAt instanceof Date);
  assert.equal(b.firstPeriodQr.created, false);
  assert.equal(b.linkExpired, true);
  assert.equal(b.activationSentAt, null, 'a link without confirmed delivery must not appear as sent');
  const selected = JSON.stringify(query.select);
  for (const forbidden of ['approvedChain', 'activationTokenHash', 'payos', 'orders', 'employees', 'menu']) assert.equal(selected.includes(forbidden), false, forbidden);
});

test('opening the activation page records the last open time for the current link only', async () => {
  const updates = [];
  const app = { id: 'a1', status: 'APPROVED', activationExpiresAt: new Date(Date.now() + 60_000), requestedPlanId: 'basic', businessName: 'Quán', representativeEmail: 'a@example.com', approvedPlan: { code: 'BASIC' } };
  const service = new PlatformAdminService({ registrationApplication: { findUnique: async () => app, updateMany: async (q) => { updates.push(q); return { count: 1 }; } } }, {}, {});
  await service.getActivation('token-value');
  assert.equal(updates.length, 1);
  assert.equal(updates[0].where.id, 'a1');
  assert.equal(updates[0].where.activationTokenHash.length, 64);
  assert.ok(updates[0].data.activationLastOpenedAt instanceof Date);
});

// ---------- 10. Self profile (CM-02) ----------

function profileFixture(user) {
  const writes = [];
  const prisma = {
    user: { findFirst: async ({ where }) => { writes.push({ read: where }); return user; } },
    $transaction: (run) => run({
      user: { update: async (q) => { writes.push({ user: q }); if (q.data.phone === '0911111111') throw new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' }); } },
      owner: { update: async (q) => writes.push({ owner: q }) },
      employee: { update: async (q) => writes.push({ employee: q }) },
    }),
  };
  return { service: new ProfileService(prisma), writes };
}

test('a user edits only their own profile row; email is never written', async () => {
  const { service, writes } = profileFixture({ id: 'owner-user', email: 'bm@example.com', phone: null, role: { code: 'OWNER' }, owner: { firstName: 'Nguyễn', lastName: 'An', dateOfBirth: null }, employee: null });
  const profile = await service.update({ id: 'owner-user' }, { firstName: 'Trần', lastName: 'Bình', phone: '0901234567', dateOfBirth: '1990-01-02' });
  assert.ok(writes.filter((w) => w.read).every((w) => w.read.id === 'owner-user'));
  assert.deepEqual(writes.find((w) => w.owner).owner.where, { userId: 'owner-user' });
  assert.deepEqual(writes.find((w) => w.user).user, { where: { id: 'owner-user' }, data: { phone: '0901234567' } });
  assert.equal(writes.some((w) => JSON.stringify(w).includes('"email"') && !w.read), false);
  assert.equal(profile.emailEditable, false);

  const cashier = profileFixture({ id: 'c1', email: 'c@example.com', phone: null, role: { code: 'CASHIER' }, owner: null, employee: { firstName: 'Lê', lastName: 'C', dateOfBirth: null, jobTitle: null, branch: { name: 'Q1' } } });
  await cashier.service.update({ id: 'c1' }, { lastName: 'Cường' });
  assert.deepEqual(cashier.writes.find((w) => w.employee).employee, { where: { userId: 'c1' }, data: { lastName: 'Cường' } });
});

test('Platform accounts without a profile row may only change phone; duplicate phone is a 409', async () => {
  const platform = profileFixture({ id: 's1', email: 's@example.com', phone: null, role: { code: 'PLATFORM_STAFF' }, owner: null, employee: null });
  assert.deepEqual((await platform.service.get({ id: 's1' })).editableFields, ['phone']);
  await assert.rejects(platform.service.update({ id: 's1' }, { firstName: 'X' }), (e) => e.getStatus?.() === 400);
  await platform.service.update({ id: 's1' }, { phone: '0901234567' });
  await assert.rejects(platform.service.update({ id: 's1' }, { phone: '0911111111' }), (e) => e.getStatus?.() === 409);
});

test('profile DTO rejects an email change and invalid phone numbers', async () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  const meta = { type: 'body', metatype: UpdateProfileDto };
  await assert.rejects(pipe.transform({ email: 'new@example.com' }, meta), (e) => e.getStatus?.() === 400);
  await assert.rejects(pipe.transform({ phone: '12ab' }, meta), (e) => e.getStatus?.() === 400);
  const ok = await pipe.transform({ firstName: ' An ', phone: '090 123 4567' }, meta);
  assert.deepEqual([ok.firstName, ok.phone], ['An', '0901234567']);
});
