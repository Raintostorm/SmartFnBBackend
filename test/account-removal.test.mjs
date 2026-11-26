import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  EMPLOYEE_ACTOR_REFERENCES,
  USER_ACTOR_REFERENCES,
  anonymizedEmail,
  maskEmail,
  removalMode,
} from '../dist/modules/users/account-removal.js';
import { StaffAccountsService } from '../dist/modules/employees/staff-accounts.service.js';
import { PlatformStaffAccountsService } from '../dist/modules/platform-admin/platform-staff-accounts.service.js';

const lc = (name) => name[0].toLowerCase() + name.slice(1);
const status = (code) => (error) => error.getStatus?.() === code;

/** Rows owned by the account: removed with it, so they do not count as "this person acted". */
const OWNED = new Set([
  'authSession.userId',
  'employee.userId',
  'owner.userId',
  'passwordSetupToken.userId',
  'passwordResetRequest.userId',
  'passwordResetAudit.subjectUserId',
  'registrationApplication.ownerUserId',
]);

describe('Account removal — reference list stays in sync with schema.prisma', () => {
  const schema = readFileSync(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
  const models = [...schema.matchAll(/model (\w+) \{([\s\S]*?)\n\}/g)].map(([, name, body]) => ({ name, body }));
  const listed = new Set([...USER_ACTOR_REFERENCES, ...EMPLOYEE_ACTOR_REFERENCES].map((r) => `${r.model}.${r.field}`));

  it('every relation and actor-id column pointing at an account is checked before deleting', () => {
    const missing = [];
    for (const { name, body } of models) {
      const fkFields = new Set();
      for (const line of body.split('\n')) {
        const relation = line.match(/^\s*\w+\s+(User|Employee)\??\s+@relation\((.*)\)/);
        if (relation) {
          const field = relation[2].match(/fields:\s*\[(\w+)\]/)?.[1];
          if (field) fkFields.add(field);
        }
        const fields = line.match(/fields:\s*\[(\w+)\]/);
        if (fields && !relation) fkFields.add(`other:${fields[1]}`);
      }
      for (const field of fkFields) {
        if (field.startsWith('other:')) continue;
        const key = `${lc(name)}.${field}`;
        if (!OWNED.has(key) && !listed.has(key)) missing.push(key);
      }
      // Actor ids stored without a foreign key (audit logs, refunds…).
      for (const line of body.split('\n')) {
        const column = line.match(/^\s*(\w+(?:UserId|EmployeeId|ById))\s+String/);
        if (!column) continue;
        const key = `${lc(name)}.${column[1]}`;
        const isFk = [...fkFields].includes(column[1]);
        if (!isFk && !OWNED.has(key) && !listed.has(key)) missing.push(key);
      }
    }
    assert.deepEqual(missing, [], `Add these to account-removal.ts (or OWNED if they belong to the account): ${missing.join(', ')}`);
  });

  it('every listed reference exists in the schema', () => {
    const stale = [...listed].filter((key) => {
      const [model, field] = key.split('.');
      const found = models.find((m) => lc(m.name) === model);
      return !found || !new RegExp(`^\\s*${field}\\s`, 'm').test(found.body);
    });
    assert.deepEqual(stale, []);
  });
});

describe('Account removal — mode and privacy', () => {
  const account = { userId: 'u1', employeeId: 'e1', status: 'SUSPENDED', staffInvitationState: 'CANCELLED', emailVerifiedAt: null, lastLoginAt: null, lastPasswordChangedAt: null };
  const client = (hits = []) =>
    new Proxy({}, { get: (_, model) => ({ findFirst: async ({ where }) => (hits.includes(`${String(model)}.${Object.keys(where)[0]}`) ? { id: 'x' } : null) }) });

  it('never activated and no footprint → DELETE; activated or any footprint → ANONYMIZE', async () => {
    assert.equal((await removalMode(client(), account)).mode, 'DELETE');
    assert.equal((await removalMode(client(), { ...account, lastLoginAt: new Date() })).mode, 'ANONYMIZE');
    assert.equal((await removalMode(client(), { ...account, emailVerifiedAt: new Date() })).mode, 'ANONYMIZE');
    const used = await removalMode(client(['order.createdByCashierId']), account);
    assert.deepEqual([used.mode, used.footprint], ['ANONYMIZE', ['order.createdByCashierId']]);
    // Audit rows where the account is only the SUBJECT (e.g. its own invitation) do not block deletion.
    assert.equal((await removalMode(client(['branchAuditLog.entityId']), account)).mode, 'DELETE');
  });

  it('masks the email kept in audit and releases the real one', () => {
    assert.equal(maskEmail('an.nguyen@gmail.com'), 'a***@gmail.com');
    assert.equal(anonymizedEmail('u1'), 'deleted+u1@deleted.invalid');
  });
});

function staffFixture({ user = {}, footprint = [] } = {}) {
  const calls = [];
  const staff = {
    id: 'employee', branchId: 'branch', employeeCode: 'NV01', firstName: 'An', lastName: 'Nguyen',
    user: { id: 'user', email: 'an.nguyen@gmail.com', role: { code: 'CASHIER' }, status: 'SUSPENDED', staffInvitationState: 'ACCEPTED', emailVerifiedAt: null, lastLoginAt: null, lastPasswordChangedAt: null, ...user },
  };
  const tx = new Proxy(
    {
      $queryRaw: async () => [],
      branch: { findFirst: async () => ({ id: 'branch', chainId: 'chain', name: 'Branch' }) },
      restaurantChain: { findFirst: async () => ({ id: 'chain' }) },
      businessSubscription: { findFirst: async () => ({ id: 's' }) },
      ownerChainAssignment: { count: async () => 1, findFirst: async () => null },
      employee: { count: async () => 1, findFirst: async ({ where }) => (where.id ? staff : null), update: async ({ data }) => calls.push({ employee: data }) },
      user: { delete: async ({ where }) => calls.push({ deleted: where.id }), update: async ({ data }) => calls.push({ user: data }) },
      passwordSetupToken: { updateMany: async () => calls.push('links'), findFirst: async () => null },
      authSession: { updateMany: async () => calls.push('sessions') },
      passwordResetRequest: { updateMany: async () => calls.push('requests'), findFirst: async () => null },
      branchAuditLog: { create: async ({ data }) => calls.push({ audit: data }), findFirst: async () => null },
    },
    {
      get: (target, key) =>
        target[key] ?? { findFirst: async ({ where }) => (footprint.includes(`${String(key)}.${Object.keys(where)[0]}`) ? { id: 'x' } : null) },
    },
  );
  const service = new StaffAccountsService({ $transaction: async (fn) => fn(tx) }, {}, {}, {});
  return { service, calls };
}

describe('Store Manager / Brand Manager remove staff accounts', () => {
  const manager = { id: 'manager-user', employeeId: 'manager', branchId: 'branch', role: 'MANAGER' };
  const owner = { id: 'owner-user', ownerId: 'owner', role: 'OWNER' };

  it('deletes a cancelled invitation that never acted; audit keeps a masked email and the IP', async () => {
    const { service, calls } = staffFixture({ user: { status: 'INACTIVE', staffInvitationState: 'CANCELLED' } });
    const preview = await service.removalPreview(manager, 'employee');
    assert.deepEqual([preview.mode, preview.allowed], ['DELETE', true]);
    const result = await service.remove(manager, 'employee', 'Mời nhầm email', '10.0.0.9');
    assert.equal(result.mode, 'DELETE');
    assert.equal(calls.find((c) => c.deleted).deleted, 'user');
    const audit = calls.find((c) => c.audit).audit;
    assert.equal(audit.action, 'STAFF_ACCOUNT_DELETED');
    assert.equal(audit.after.email, 'a***@gmail.com');
    assert.equal(audit.after.ipAddress, '10.0.0.9');
    assert.equal(JSON.stringify(audit).includes('an.nguyen@gmail.com'), false);
    // Audit is written before the row is deleted, in the same transaction.
    assert.ok(calls.findIndex((c) => c.audit) < calls.findIndex((c) => c.deleted));
  });

  it('anonymizes a locked cashier who sold orders: history kept, personal data wiped, email released', async () => {
    const { service, calls } = staffFixture({ user: { lastLoginAt: new Date(), emailVerifiedAt: new Date() }, footprint: ['order.createdByCashierId'] });
    const result = await service.remove(manager, 'employee', 'Đã nghỉ việc');
    assert.equal(result.mode, 'ANONYMIZE');
    assert.equal(calls.some((c) => c.deleted), false);
    const user = calls.find((c) => c.user).user;
    assert.equal(user.email, 'deleted+user@deleted.invalid');
    assert.deepEqual([user.phone, user.status, user.deletedAt instanceof Date], [null, 'SUSPENDED', true]);
    const employee = calls.find((c) => c.employee).employee;
    assert.deepEqual([employee.firstName, employee.lastName, employee.dateOfBirth, employee.status], ['Tài khoản', 'đã xoá', null, 'TERMINATED']);
    assert.ok(calls.includes('sessions') && calls.includes('links'));
    assert.equal(calls.find((c) => c.audit).audit.after.footprint[0], 'order.createdByCashierId');
  });

  it('refuses an account still in use, and keeps the BR-05 scope', async () => {
    const active = staffFixture({ user: { status: 'ACTIVE', staffInvitationState: 'ACCEPTED' } });
    await assert.rejects(active.service.remove(manager, 'employee', 'Thử xoá'), status(409));
    assert.equal(active.calls.some((c) => c.deleted || c.user), false);
    const preview = await active.service.removalPreview(manager, 'employee');
    assert.equal(preview.allowed, false);
    // Brand Manager may not remove a cashier directly (only Store Managers).
    await assert.rejects(staffFixture().service.remove(owner, 'employee', 'Thử xoá'), status(403));
  });
});

describe('Platform Admin removes Platform Staff', () => {
  function fixture({ user = {}, footprint = [] } = {}) {
    const calls = [];
    const row = { id: 'staff', email: 'ps@smartfnb.vn', status: 'SUSPENDED', staffInvitationState: 'ACCEPTED', emailVerifiedAt: new Date(), lastLoginAt: new Date(), lastPasswordChangedAt: null, ...user };
    const base = {
      $queryRaw: async () => [],
      user: { findFirst: async () => row, delete: async () => calls.push('deleted'), update: async ({ data }) => calls.push({ user: data }) },
      platformSupportAction: { create: async ({ data }) => calls.push({ support: data }), findFirst: async ({ where }) => (footprint.includes('platformSupportAction.actorUserId') && where.actorUserId ? { id: 'x' } : null) },
      passwordSetupToken: { updateMany: async () => calls.push('links') },
      authSession: { updateMany: async () => calls.push('sessions') },
      passwordResetRequest: { updateMany: async () => undefined, findFirst: async () => null },
    };
    const tx = new Proxy(base, { get: (t, k) => t[k] ?? { findFirst: async () => null } });
    const service = new PlatformStaffAccountsService({ ...base, $transaction: async (fn) => fn(tx), user: base.user }, {}, {});
    return { service, calls };
  }

  it('anonymizes a staff member who handled support, with a masked email in the audit', async () => {
    const { service, calls } = fixture({ footprint: ['platformSupportAction.actorUserId'] });
    const result = await service.remove('staff', 'Nghỉ việc', 'admin-1', '1.2.3.4');
    assert.equal(result.mode, 'ANONYMIZE');
    const support = calls.find((c) => c.support).support;
    assert.deepEqual([support.action, support.details.email, support.details.ipAddress], ['ANONYMIZE_PLATFORM_STAFF', 'p***@smartfnb.vn', '1.2.3.4']);
    assert.equal(calls.find((c) => c.user).user.email, 'deleted+staff@deleted.invalid');
  });

  it('deletes a never-activated staff invite, and refuses unlocked accounts or self-removal', async () => {
    const fresh = fixture({ user: { emailVerifiedAt: null, lastLoginAt: null } });
    assert.equal((await fresh.service.remove('staff', 'Tạo nhầm', 'admin-1')).mode, 'DELETE');
    assert.ok(fresh.calls.includes('deleted'));
    await assert.rejects(fixture({ user: { status: 'ACTIVE' } }).service.remove('staff', 'x x x', 'admin-1'), status(409));
    await assert.rejects(fixture().service.remove('staff', 'x x x', 'staff'), status(403));
  });
});
