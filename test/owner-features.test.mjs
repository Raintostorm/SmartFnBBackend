import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BranchStatus, UserStatus } from '../dist/generated/prisma/client.js';
import { AppRole } from '../dist/modules/auth/app-role.enum.js';
import { BranchesService } from '../dist/modules/branches/branches.service.js';
import { EmployeesService } from '../dist/modules/employees/employees.service.js';
import { MenuService } from '../dist/modules/menu/menu.service.js';
import { ReportsService } from '../dist/modules/reports/reports.service.js';
import { PlanQuotaService } from '../dist/modules/subscription/plan-quota.service.js';

const owner = {
  id: 'user-owner',
  email: 'owner@example.com',
  phone: null,
  role: AppRole.OWNER,
  sessionId: 'session-id',
  employeeId: null,
  ownerId: 'owner-id',
  branchId: null,
};

function weeklyHours(openTime, closeTime, isClosed = false) {
  return Array.from({ length: 7 }, (_unused, dayOfWeek) => ({
    dayOfWeek,
    openTime,
    closeTime,
    isClosed,
  }));
}

function branchWithHours(overrides = {}) {
  return {
    status: BranchStatus.ACTIVE,
    timezone: 'UTC',
    operatingHours: weeklyHours('08:00', '22:00'),
    specialHours: [],
    ...overrides,
  };
}

describe('Branch creation seeds opening hours', () => {
  function serviceFor(captured) {
    return new BranchesService(
      {
        restaurantChain: { count: async () => 1 },
        branch: {
          count: async () => 0,
          create: async (args) => {
            captured.args = args;
            return { id: 'branch-new' };
          },
        },
      },
      { assertCanManageChain: async () => undefined },
      { assertWithinQuota: async () => undefined },
    );
  }

  it('applies one open/close pair to all seven days', async () => {
    const captured = {};
    await serviceFor(captured).createBranch(
      'chain-one',
      {
        code: 'HCM-D1',
        name: 'Chi nhánh 1',
        addressLine1: '1 Nguyễn Huệ',
        city: 'Hồ Chí Minh',
        openTime: '08:00',
        closeTime: '22:00',
      },
      owner,
    );

    const created = captured.args.data.operatingHours.create;
    assert.equal(created.length, 7);
    assert.deepEqual(
      created.map(({ dayOfWeek }) => dayOfWeek),
      [0, 1, 2, 3, 4, 5, 6],
    );
    assert.ok(created.every(({ openTime }) => openTime === '08:00'));
    // The hour fields must not leak into the branch row itself.
    assert.equal(captured.args.data.openTime, undefined);
    assert.equal(captured.args.data.closeTime, undefined);
  });

  it('creates a branch without hours when neither time is given', async () => {
    const captured = {};
    await serviceFor(captured).createBranch(
      'chain-one',
      { code: 'HCM-D2', name: 'Chi nhánh 2', addressLine1: '2 Lê Lợi', city: 'Hồ Chí Minh' },
      owner,
    );
    assert.equal(captured.args.data.operatingHours, undefined);
  });

  it('rejects an opening time without a closing time', async () => {
    await assert.rejects(
      serviceFor({}).createBranch(
        'chain-one',
        {
          code: 'HCM-D3',
          name: 'Chi nhánh 3',
          addressLine1: '3 Hàm Nghi',
          city: 'Hồ Chí Minh',
          openTime: '08:00',
        },
        owner,
      ),
      (error) => error?.getStatus?.() === 400,
    );
  });
});

describe('Branch overview open state', () => {
  const service = new BranchesService({}, {}, {});
  const resolve = (branch, iso) => service.resolveOpenState(branch, new Date(iso));

  it('reports a branch open inside its hours', () => {
    const state = resolve(branchWithHours(), '2026-09-18T10:00:00.000Z');
    assert.equal(state.isOpenNow, true);
    assert.equal(state.reason, 'OPEN');
    assert.equal(state.source, 'WEEKLY');
    assert.equal(state.localTime, '10:00');
  });

  it('reports a branch closed outside its hours', () => {
    const state = resolve(branchWithHours(), '2026-09-18T23:30:00.000Z');
    assert.equal(state.isOpenNow, false);
    assert.equal(state.reason, 'OUTSIDE_HOURS');
  });

  it('treats a closing time before the opening time as an overnight shift', () => {
    const overnight = branchWithHours({ operatingHours: weeklyHours('22:00', '02:00') });
    assert.equal(resolve(overnight, '2026-09-18T23:30:00.000Z').isOpenNow, true);
    assert.equal(resolve(overnight, '2026-09-18T01:00:00.000Z').isOpenNow, true);
    assert.equal(resolve(overnight, '2026-09-18T03:00:00.000Z').isOpenNow, false);
  });

  it('lets a special hour override the weekly schedule', () => {
    const state = resolve(
      branchWithHours({
        specialHours: [
          {
            date: new Date('2026-09-18T00:00:00.000Z'),
            openTime: null,
            closeTime: null,
            isClosed: true,
            note: 'Nghỉ lễ',
          },
        ],
      }),
      '2026-09-18T10:00:00.000Z',
    );
    assert.equal(state.isOpenNow, false);
    assert.equal(state.reason, 'CLOSED_TODAY');
    assert.equal(state.source, 'SPECIAL_HOUR');
    assert.equal(state.note, 'Nghỉ lễ');
  });

  it('ignores a special hour dated for another day', () => {
    const state = resolve(
      branchWithHours({
        specialHours: [
          {
            date: new Date('2026-09-19T00:00:00.000Z'),
            openTime: null,
            closeTime: null,
            isClosed: true,
            note: 'Nghỉ lễ',
          },
        ],
      }),
      '2026-09-18T10:00:00.000Z',
    );
    assert.equal(state.isOpenNow, true);
    assert.equal(state.source, 'WEEKLY');
  });

  it('never reports a suspended or closed branch as open', () => {
    for (const status of [BranchStatus.MAINTENANCE, BranchStatus.INACTIVE]) {
      const state = resolve(branchWithHours({ status }), '2026-09-18T10:00:00.000Z');
      assert.equal(state.isOpenNow, false);
      assert.equal(state.reason, `BRANCH_${status}`);
    }
  });

  it('reports NO_SCHEDULE when the branch has no hours at all', () => {
    const state = resolve(branchWithHours({ operatingHours: [] }), '2026-09-18T10:00:00.000Z');
    assert.equal(state.isOpenNow, false);
    assert.equal(state.reason, 'NO_SCHEDULE');
  });

  it('resolves the local day in the branch timezone, not UTC', () => {
    // 23:30Z on the 18th is already 06:30 on the 19th in Ho Chi Minh City.
    const state = resolve(
      branchWithHours({ timezone: 'Asia/Ho_Chi_Minh' }),
      '2026-09-18T23:30:00.000Z',
    );
    assert.equal(state.localDate, '2026-09-19');
    assert.equal(state.localTime, '06:30');
  });
});

describe('Service plan quota', () => {
  function quotaService({ maxBranches, branchCount, upgradePlans = [] }) {
    return new PlanQuotaService({
      businessSubscription: {
        findFirst: async () => ({
          plan: {
            id: 'plan-basic',
            code: 'BASIC',
            name: 'Basic',
            description: null,
            monthlyPrice: { minus: (other) => ({ toString: () => `diff-${other}` }) },
            maxBranches,
            maxAccounts: 10,
            maxTables: 20,
          },
        }),
      },
      branch: { count: async () => branchCount },
      employee: { count: async () => 0 },
      ownerChainAssignment: { count: async () => 1 },
      restaurantTable: { count: async () => 0 },
      servicePlan: { findMany: async () => upgradePlans },
    });
  }

  it('allows a branch while the plan has room', async () => {
    await quotaService({ maxBranches: 3, branchCount: 2 }).assertWithinQuota(
      'chain-one',
      'branches',
    );
  });

  it('blocks at the limit and suggests the plans that would unblock it', async () => {
    const upgrade = {
      id: 'plan-pro',
      code: 'PRO',
      name: 'Pro',
      description: null,
      monthlyPrice: { minus: () => 'price-difference' },
      maxBranches: 10,
      maxAccounts: 50,
      maxTables: 200,
    };
    const service = quotaService({ maxBranches: 3, branchCount: 3, upgradePlans: [upgrade] });

    await assert.rejects(
      service.assertWithinQuota('chain-one', 'branches'),
      (error) => {
        const body = error.getResponse();
        assert.equal(error.getStatus(), 409);
        assert.equal(body.error, 'PLAN_LIMIT_REACHED');
        assert.deepEqual(body.quota, {
          resource: 'branches',
          used: 3,
          limit: 3,
          remaining: 0,
        });
        assert.equal(body.suggestedPlans.length, 1);
        assert.equal(body.suggestedPlans[0].code, 'PRO');
        return true;
      },
    );
  });

  it('counts owners and employees together against the account limit', async () => {
    const service = new PlanQuotaService({
      businessSubscription: {
        findFirst: async () => ({
          plan: { id: 'p', code: 'B', name: 'B', monthlyPrice: {}, maxBranches: 5, maxAccounts: 4, maxTables: 20 },
        }),
      },
      branch: { count: async () => 1 },
      employee: { count: async () => 3 },
      ownerChainAssignment: { count: async () => 1 },
      restaurantTable: { count: async () => 0 },
      servicePlan: { findMany: async () => [] },
    });

    const snapshot = await service.getQuotaSnapshot('chain-one');
    const accounts = snapshot.quotas.find(({ resource }) => resource === 'accounts');
    assert.deepEqual(accounts, { resource: 'accounts', used: 4, limit: 4, remaining: 0 });
  });
});

describe('Owner staff administration', () => {
  function employeesServiceFor(roleCode) {
    return new EmployeesService(
      {
        employee: {
          findFirst: async () => ({
            id: 'employee-one',
            employeeCode: 'M-001',
            firstName: 'An',
            lastName: 'Nguyen',
            branch: { id: 'branch-one', name: 'Chi nhánh 1', chainId: 'chain-one' },
            user: { id: 'user-target', email: 'target@example.com', role: { code: roleCode } },
          }),
        },
      },
      { getAccessibleBranchIds: async () => ['branch-one'] },
    );
  }

  it('refuses to lock a WAITER account', async () => {
    await assert.rejects(
      employeesServiceFor(AppRole.WAITER).updateManagerAccountStatus(owner, 'employee-one', {
        status: UserStatus.SUSPENDED,
      }),
      (error) => error?.getStatus?.() === 403,
    );
  });

  it('refuses to reset a KITCHEN password', async () => {
    await assert.rejects(
      employeesServiceFor(AppRole.KITCHEN).resetManagerPassword(owner, 'employee-one'),
      (error) => error?.getStatus?.() === 403,
    );
  });

  it('rejects a branch filter outside the owner scope', async () => {
    const service = new EmployeesService({}, { getAccessibleBranchIds: async () => ['branch-one'] });
    await assert.rejects(
      service.listEmployees(owner, { branchId: 'branch-other', page: 1, limit: 20 }),
      (error) => error?.getStatus?.() === 403,
    );
  });

  it('denies staff administration to a MANAGER', async () => {
    const service = new EmployeesService({}, {});
    await assert.rejects(
      service.listEmployees({ ...owner, role: AppRole.MANAGER }, { page: 1, limit: 20 }),
      (error) => error?.getStatus?.() === 403,
    );
  });
});

describe('Chain menu boundaries', () => {
  it('rejects branches that belong to another chain', async () => {
    const service = new MenuService(
      {
        menuItem: {
          findFirst: async () => ({ id: 'item-one', sku: 'RICE', name: 'Cơm', isActive: true }),
        },
        // Only one of the two requested branches is inside the chain.
        branch: { findMany: async () => [{ id: 'branch-one' }] },
      },
      { assertCanManageChain: async () => undefined },
    );

    await assert.rejects(
      service.setItemBranches('chain-one', 'item-one', {
        branchIds: ['branch-one', 'branch-foreign'],
      }),
      (error) => {
        assert.equal(error.getStatus(), 400);
        assert.match(error.message, /branch-foreign/);
        return true;
      },
    );
  });

  it('refuses a branch availability update with no fields', async () => {
    const service = new MenuService({}, { assertCanManageBranch: async () => undefined });
    await assert.rejects(
      service.updateBranchMenuItem('branch-one', 'item-one', {}, owner),
      (error) => error?.getStatus?.() === 400,
    );
  });
});

describe('Report range validation', () => {
  const service = new ReportsService({}, {});

  it('defaults to the last 30 days', () => {
    const { fromDate, toDate } = service.resolveRange({ to: '2026-09-30' }, 'UTC');
    assert.equal(fromDate, '2026-09-01');
    assert.equal(toDate, '2026-09-30');
  });

  it('keeps the end date inclusive', () => {
    const { from, to } = service.resolveRange({ from: '2026-09-18', to: '2026-09-18' }, 'UTC');
    assert.equal(from.toISOString(), '2026-09-18T00:00:00.000Z');
    assert.equal(to.toISOString(), '2026-09-19T00:00:00.000Z');
  });

  it('anchors the range to midnight in the chain timezone, not UTC', () => {
    // Without this, a 17:00Z order on the 18th lands in the 19th bucket and
    // falls outside the range it was filtered by.
    const { from, to } = service.resolveRange(
      { from: '2026-09-18', to: '2026-09-18' },
      'Asia/Ho_Chi_Minh',
    );
    assert.equal(from.toISOString(), '2026-09-17T17:00:00.000Z');
    assert.equal(to.toISOString(), '2026-09-18T17:00:00.000Z');
  });

  it('rejects an inverted range', () => {
    assert.throws(
      () => service.resolveRange({ from: '2026-09-30', to: '2026-09-01' }, 'UTC'),
      (error) => error?.getStatus?.() === 400,
    );
  });

  it('rejects a range longer than a year', () => {
    assert.throws(
      () => service.resolveRange({ from: '2020-01-01', to: '2026-09-01' }, 'UTC'),
      (error) => error?.getStatus?.() === 400,
    );
  });

  it('denies chain reports to non-owner roles', async () => {
    await assert.rejects(
      service.compareBranches({ ...owner, role: AppRole.MANAGER }, {}),
      (error) => error?.getStatus?.() === 403,
    );
  });
});

describe('Report chart buckets', () => {
  const service = new ReportsService({}, {});
  const scope = (fromDate, toDate) => ({ fromDate, toDate });

  it('fills every day in the range, including days with no sales', () => {
    const keys = service.buildBucketKeys(scope('2026-09-01', '2026-09-05'), 'day');
    assert.deepEqual(keys, [
      '2026-09-01',
      '2026-09-02',
      '2026-09-03',
      '2026-09-04',
      '2026-09-05',
    ]);
  });

  it('starts weekly buckets on Monday, matching Postgres date_trunc', () => {
    // 2026-09-03 is a Thursday; its week starts Monday 2026-08-31.
    const keys = service.buildBucketKeys(scope('2026-09-03', '2026-09-20'), 'week');
    assert.deepEqual(keys, ['2026-08-31', '2026-09-07', '2026-09-14']);
  });

  it('starts monthly buckets on the first of the month', () => {
    const keys = service.buildBucketKeys(scope('2026-09-18', '2026-11-02'), 'month');
    assert.deepEqual(keys, ['2026-09-01', '2026-10-01', '2026-11-01']);
  });

  it('never runs past the end of the range', () => {
    const keys = service.buildBucketKeys(scope('2026-09-18', '2026-09-18'), 'day');
    assert.deepEqual(keys, ['2026-09-18']);
  });
});
