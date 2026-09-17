import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BranchAreaStatus, BranchAreaType, BranchStatus } from '../dist/generated/prisma/client.js';
import { AppRole } from '../dist/modules/auth/app-role.enum.js';
import { BranchAccessService } from '../dist/modules/branches/branch-access.service.js';
import { BranchesService } from '../dist/modules/branches/branches.service.js';
import { OwnerAssignmentsService } from '../dist/modules/branches/owner-assignments.service.js';

function authenticatedUser(role, branchId = null) {
  return {
    id: `user-${role}`,
    email: `${role.toLowerCase()}@example.com`,
    phone: null,
    role,
    sessionId: 'session-id',
    employeeId: role === AppRole.OWNER ? null : 'employee-id',
    ownerId: role === AppRole.OWNER ? 'owner-id' : null,
    branchId,
  };
}

describe('BranchesService role scopes', () => {
  it('limits staff branch listing to the assigned branch', async () => {
    let receivedWhere;
    const prisma = {
      branch: {
        findMany: async ({ where }) => {
          receivedWhere = where;
          return [];
        },
      },
    };
    const branchAccess = {
      getAccessibleBranchIds: async () => ['branch-one'],
    };
    const service = new BranchesService(prisma, branchAccess);

    await service.listBranches(authenticatedUser(AppRole.WAITER, 'branch-one'), {
      chainId: 'ignored-for-staff',
    });

    assert.deepEqual(receivedWhere.id, { in: ['branch-one'] });
    assert.equal(receivedWhere.chainId, undefined);
  });

  it('rejects access to a different branch before querying it', async () => {
    const branchAccess = {
      assertCanAccessBranch: async () => {
        const error = new Error('forbidden');
        error.getStatus = () => 403;
        throw error;
      },
    };
    const service = new BranchesService({}, branchAccess);

    await assert.rejects(
      service.getBranch('branch-two', authenticatedUser(AppRole.CASHIER, 'branch-one')),
      (error) => error?.getStatus?.() === 403,
    );
  });

  it('shows only dining/pickup to WAITER and kitchen/bar to KITCHEN', async () => {
    const areaFilters = [];
    const prisma = {
      branch: { count: async () => 1 },
      branchArea: {
        findMany: async ({ where }) => {
          areaFilters.push(where.type.in);
          return [];
        },
      },
    };
    const branchAccess = { assertCanAccessBranch: async () => undefined };
    const service = new BranchesService(prisma, branchAccess);

    await service.listAreas('branch-one', authenticatedUser(AppRole.WAITER, 'branch-one'));
    await service.listAreas('branch-one', authenticatedUser(AppRole.KITCHEN, 'branch-one'));

    assert.deepEqual(areaFilters[0], [BranchAreaType.DINING, BranchAreaType.PICKUP]);
    assert.deepEqual(areaFilters[1], [BranchAreaType.KITCHEN, BranchAreaType.BAR]);
  });

  it('allows KITCHEN to change only kitchen/bar area status', async () => {
    let updateCount = 0;
    const prisma = {
      branchArea: {
        findFirst: async ({ where }) => ({
          id: where.id,
          branchId: where.branchId,
          type: where.id === 'dining-area' ? BranchAreaType.DINING : BranchAreaType.KITCHEN,
        }),
        update: async () => {
          updateCount += 1;
          return { status: BranchAreaStatus.INACTIVE };
        },
      },
    };
    const branchAccess = { assertCanAccessBranch: async () => undefined };
    const service = new BranchesService(prisma, branchAccess);
    const kitchen = authenticatedUser(AppRole.KITCHEN, 'branch-one');

    await assert.rejects(
      service.updateAreaStatus('branch-one', 'dining-area', BranchAreaStatus.INACTIVE, kitchen),
      (error) => error?.getStatus?.() === 403,
    );

    await service.updateAreaStatus(
      'branch-one',
      'kitchen-area',
      BranchAreaStatus.INACTIVE,
      kitchen,
    );
    assert.equal(updateCount, 1);
  });

  it('rejects WAITER from changing area status even when called outside the controller', async () => {
    const service = new BranchesService({}, {});

    await assert.rejects(
      service.updateAreaStatus(
        'branch-one',
        'dining-area',
        BranchAreaStatus.INACTIVE,
        authenticatedUser(AppRole.WAITER, 'branch-one'),
      ),
      (error) => error?.getStatus?.() === 403,
    );
  });

  it('does not let MANAGER deactivate an assigned branch', async () => {
    const branchAccess = { assertCanManageBranch: async () => undefined };
    const service = new BranchesService(
      { branch: { findFirst: async () => ({ status: BranchStatus.ACTIVE }) } },
      branchAccess,
    );

    await assert.rejects(
      service.updateBranchStatus(
        'branch-one',
        BranchStatus.INACTIVE,
        authenticatedUser(AppRole.MANAGER, 'branch-one'),
      ),
      (error) => error?.getStatus?.() === 403,
    );
  });

  it('does not let MANAGER reactivate a branch closed by ADMIN', async () => {
    const branchAccess = { assertCanManageBranch: async () => undefined };
    const service = new BranchesService(
      { branch: { findFirst: async () => ({ status: BranchStatus.INACTIVE }) } },
      branchAccess,
    );

    await assert.rejects(
      service.updateBranchStatus(
        'branch-one',
        BranchStatus.ACTIVE,
        authenticatedUser(AppRole.MANAGER, 'branch-one'),
      ),
      (error) => error?.getStatus?.() === 403,
    );
  });
});

describe('BranchAccessService owner and manager scopes', () => {
  it('limits a MANAGER to exactly its Employee.branchId', async () => {
    const service = new BranchAccessService({});
    const branchIds = await service.getAccessibleBranchIds(
      authenticatedUser(AppRole.MANAGER, 'branch-one'),
    );
    assert.deepEqual(branchIds, ['branch-one']);
  });

  it('gives an OWNER every branch in its assigned chains', async () => {
    const prisma = {
      ownerChainAssignment: {
        findMany: async () => [{ chainId: 'chain-one' }, { chainId: 'chain-two' }],
      },
      branch: {
        findMany: async ({ where }) => {
          assert.deepEqual(where.chainId.in, ['chain-one', 'chain-two']);
          return [{ id: 'branch-one' }, { id: 'branch-two' }];
        },
      },
    };
    const service = new BranchAccessService(prisma);
    const branchIds = await service.getAccessibleBranchIds(authenticatedUser(AppRole.OWNER));
    assert.deepEqual(branchIds, ['branch-one', 'branch-two']);
  });

  it('rejects a MANAGER from an unassigned branch', async () => {
    const service = new BranchAccessService({});

    await assert.rejects(
      service.assertCanManageBranch(
        authenticatedUser(AppRole.MANAGER, 'branch-one'),
        'branch-three',
      ),
      (error) => error?.getStatus?.() === 403,
    );
  });
});

describe('OwnerAssignmentsService', () => {
  it('replaces the complete list of chains assigned by ADMIN', async () => {
    let assignedChainIds = [];
    const chainById = {
      'chain-one': { id: 'chain-one', code: 'C1', name: 'First' },
      'chain-two': { id: 'chain-two', code: 'C2', name: 'Second' },
    };
    const prisma = {
      owner: {
        findFirst: async () => ({
          id: 'owner-one',
          ownerCode: 'OWN-001',
          chainAssignments: assignedChainIds.map((chainId) => ({
            chain: chainById[chainId],
          })),
        }),
      },
      restaurantChain: { count: async ({ where }) => where.id.in.length },
      $transaction: async (callback) =>
        callback({
          ownerChainAssignment: {
            deleteMany: async () => {
              assignedChainIds = [];
            },
            createMany: async ({ data }) => {
              assignedChainIds = data.map(({ chainId }) => chainId);
            },
          },
        }),
    };
    const service = new OwnerAssignmentsService(prisma);

    const result = await service.replaceOwnerChains(
      'owner-one',
      ['chain-one', 'chain-two'],
      'admin-one',
    );

    assert.deepEqual(assignedChainIds, ['chain-one', 'chain-two']);
    assert.deepEqual(
      result.chains.map(({ id }) => id),
      ['chain-one', 'chain-two'],
    );
  });
});
