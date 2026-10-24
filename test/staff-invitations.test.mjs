import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { StaffAccountsService } from '../dist/modules/employees/staff-accounts.service.js';
import { AuthService } from '../dist/modules/auth/auth.service.js';
import { EmployeesController } from '../dist/modules/employees/employees.controller.js';
import { AuthController } from '../dist/modules/auth/auth.controller.js';

const owner = { id: 'owner-user', ownerId: 'owner', role: 'OWNER' };
const manager = { id: 'manager-user', employeeId: 'manager', branchId: 'branch', role: 'MANAGER' };
const input = {
  branchId: 'branch',
  role: 'CASHIER',
  email: ' Staff@example.com ',
  firstName: 'An',
  lastName: 'Nguyen',
};
function fixture() {
  const calls = [];
  const staff = {
    id: 'employee',
    branchId: 'branch',
    firstName: 'An',
    lastName: 'Nguyen',
    user: {
      id: 'user',
      email: 'staff@example.com',
      role: { code: 'CASHIER' },
      status: 'INACTIVE',
      staffInvitationState: 'PENDING',
    },
  };
  const tx = {
    $queryRaw: async () => calls.push('lock'),
    branch: { findFirst: async () => ({ id: 'branch', chainId: 'chain', name: 'Branch' }) },
    restaurantChain: { findFirst: async () => ({ id: 'chain' }) },
    businessSubscription: { findFirst: async () => ({ plan: { maxAccounts: 5 } }) },
    ownerChainAssignment: { count: async () => 1 },
    employee: {
      count: async () => 1,
      findFirst: async () => staff,
      create: async ({ data }) => {
        calls.push({ created: data });
        return staff;
      },
    },
    role: { findUniqueOrThrow: async () => ({ id: 'role' }) },
    user: {
      update: async ({ data }) => {
        calls.push({ user: data });
        return data;
      },
    },
    passwordSetupToken: {
      findFirst: async () => null,
      updateMany: async () => calls.push('invalidate'),
      create: async ({ data }) => calls.push({ token: data }),
    },
    authSession: { updateMany: async () => calls.push('revoke') },
    emailOutbox: {
      create: async ({ data }) => {
        calls.push({ email: data });
        return { id: 'outbox' };
      },
    },
    branchAuditLog: { create: async ({ data }) => calls.push({ audit: data }) },
  };
  const service = new StaffAccountsService(
    {
      $transaction: async (fn, opts) => {
        assert.equal(opts.isolationLevel, 'Serializable');
        const result = await fn(tx);
        calls.push('commit');
        return result;
      },
    },
    { hash: async () => 'random-password-hash' },
    {
      deliver: async () => {
        assert.equal(calls.at(-1), 'commit');
        calls.push('deliver');
        return 'SENT';
      },
    },
  );
  return { service, tx, calls, staff };
}
const status = (code) => (error) => error.getStatus?.() === code;

describe('Staff email invitations', () => {
  it('retires direct-password HTTP creation routes', () => {
    assert.equal(
      Reflect.getMetadata('path', EmployeesController.prototype.createAccount),
      'invitations',
    );
    assert.equal(AuthController.prototype.registerManager, undefined);
    assert.equal(AuthController.prototype.registerStaff, undefined);
  });
  for (const role of ['MANAGER', 'CASHIER', 'BARISTA'])
    it(`Owner invites ${role} with no exposed password or token`, async () => {
      const f = fixture();
      const result = await f.service.invite(owner, { ...input, role });
      const created = f.calls.find((c) => c.created).created;
      assert.equal(created.user.create.status, 'INACTIVE');
      assert.equal(created.user.create.staffInvitationState, 'PENDING');
      assert.equal(created.user.create.email, 'staff@example.com');
      const email = f.calls.find((c) => c.email).email;
      const token = f.calls.find((c) => c.token).token;
      assert.equal(
        token.tokenHash,
        createHash('sha256').update(email.payload.setupToken).digest('hex'),
      );
      assert.ok(token.expiresAt > new Date(Date.now() + 23 * 3600000));
      assert.equal(JSON.stringify(result).includes(email.payload.setupToken), false);
      assert.equal(f.calls.find((c) => c.audit).audit.actorEmployeeId, null);
    });
  for (const role of ['CASHIER', 'BARISTA'])
    it(`Manager invites ${role} in own branch`, async () => {
      await fixture().service.invite(manager, { ...input, role });
    });
  it('denies Manager inviting Manager and non-management actors', async () => {
    await assert.rejects(
      fixture().service.invite(manager, { ...input, role: 'MANAGER' }),
      status(403),
    );
    await assert.rejects(
      fixture().service.invite({ ...manager, role: 'CASHIER' }, input),
      status(403),
    );
  });
  it('denies another branch and another owner business', async () => {
    await assert.rejects(
      fixture().service.invite({ ...manager, branchId: 'other' }, input),
      status(403),
    );
    const f = fixture();
    f.tx.ownerChainAssignment.count = async () => 0;
    await assert.rejects(f.service.invite(owner, input), status(403));
  });
  it('counts pending accounts against quota and rejects inactive subscriptions', async () => {
    const f = fixture();
    f.tx.employee.count = async () => 4;
    await assert.rejects(f.service.invite(owner, input), status(409));
    assert.equal(
      f.calls.some((c) => c.created),
      false,
    );
    const g = fixture();
    g.tx.businessSubscription.findFirst = async () => null;
    await assert.rejects(g.service.invite(owner, input), status(403));
  });
  it('rotates setup token on resend and enforces cooldown', async () => {
    const f = fixture();
    await f.service.sendSetup(owner, 'employee', 'Resend email', true);
    assert.ok(f.calls.includes('invalidate'));
    assert.ok(f.calls.includes('revoke'));
    const g = fixture();
    g.tx.passwordSetupToken.findFirst = async () => ({ createdAt: new Date() });
    await assert.rejects(g.service.sendSetup(owner, 'employee', 'Resend email', true), status(429));
    assert.equal(g.calls.includes('invalidate'), false);
  });
  it('cancels pending invitations, invalidates tokens and audits actor', async () => {
    const f = fixture();
    await f.service.cancel(manager, 'employee', 'Wrong email');
    assert.equal(f.calls.find((c) => c.user).user.staffInvitationState, 'CANCELLED');
    assert.equal(f.calls.find((c) => c.audit).audit.actorUserId, manager.id);
    assert.ok(f.calls.includes('invalidate'));
    assert.ok(f.calls.includes('revoke'));
  });
  it('cannot activate pending invitations or resend cancelled ones', async () => {
    const f = fixture();
    await assert.rejects(f.service.status(owner, 'employee', 'ACTIVE', 'Enable'), status(409));
    f.staff.user.staffInvitationState = 'CANCELLED';
    await assert.rejects(f.service.sendSetup(owner, 'employee', 'Resend', true), status(409));
  });
});

function activationFixture() {
  const current = {
    id: 'user',
    status: 'INACTIVE',
    staffInvitationState: 'PENDING',
    role: { code: 'CASHIER' },
    employee: {
      id: 'employee',
      branchId: 'branch',
      status: 'ACTIVE',
      branch: {
        status: 'ACTIVE',
        chain: {
          id: 'chain',
          status: 'ACTIVE',
          subscription: { status: 'ACTIVE', expiresAt: new Date(Date.now() + 86400000) },
        },
      },
    },
  };
  let used = false;
  const writes = [];
  const tx = {
    $queryRaw: async () => [],
    user: { findUnique: async () => current, update: async ({ data }) => writes.push(data) },
    passwordSetupToken: {
      updateMany: async () => {
        if (used) return { count: 0 };
        used = true;
        return { count: 1 };
      },
    },
    authSession: { updateMany: async () => undefined },
    passwordSetupAttempt: { deleteMany: async () => undefined },
    branchAuditLog: { create: async () => undefined },
  };
  const db = {
    passwordSetupAttempt: { findUnique: async () => null },
    passwordSetupToken: {
      findFirst: async () => ({
        id: 'token',
        userId: 'user',
        user: { ...current, employee: { branch: { chainId: 'chain' } } },
      }),
    },
    $transaction: (fn) => fn(tx),
  };
  const auth = new AuthService(
    {},
    db,
    {},
    { getOrThrow: () => 'test' },
    { hash: async () => 'hash' },
  );
  return { auth, current, writes };
}
describe('Invitation activation', () => {
  const dto = { token: 'x'.repeat(43), password: 'StrongPass123' };
  it('activates once and rejects reuse', async () => {
    const f = activationFixture();
    await f.auth.setupPassword(dto);
    assert.equal(f.writes[0].status, 'ACTIVE');
    assert.equal(f.writes[0].staffInvitationState, 'ACCEPTED');
    await assert.rejects(f.auth.setupPassword(dto), status(401));
    assert.equal(f.writes.length, 1);
  });
  it('rechecks cancellation and suspension inside transaction', async () => {
    for (const patch of [{ staffInvitationState: 'CANCELLED' }, { status: 'SUSPENDED' }]) {
      const f = activationFixture();
      Object.assign(f.current, patch);
      await assert.rejects(f.auth.setupPassword(dto), status(401));
      assert.equal(f.writes.length, 0);
    }
  });
  it('rejects inactive branch and expired subscription', async () => {
    const f = activationFixture();
    f.current.employee.branch.status = 'INACTIVE';
    await assert.rejects(f.auth.setupPassword(dto), status(403));
    const g = activationFixture();
    g.current.employee.branch.chain.subscription.expiresAt = new Date(0);
    await assert.rejects(g.auth.setupPassword(dto), status(403));
  });
});
