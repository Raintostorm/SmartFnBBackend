import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MenuImportsService } from '../dist/modules/menu/menu-imports.service.js';

const owner = { id: 'user-1', role: 'OWNER', ownerId: 'owner-1' };
const draft = {
  categories: [
    {
      name: 'Cà phê',
      items: [
        {
          name: 'Cà phê sữa',
          description: '',
          price: 25000,
          action: 'SKIP',
          existingItemId: '',
          branchIds: [],
          sizes: [],
          extras: [],
          warning: '',
        },
      ],
    },
  ],
  unresolved: [],
};

describe('Menu imports', () => {
  it('saves a reviewed draft without writing any menu rows', async () => {
    let update;
    const record = {
      id: 'import-1',
      chainId: 'chain-1',
      status: 'WAITING_REVIEW',
      draft,
      expiresAt: new Date(Date.now() + 60_000),
    };
    const prisma = {
      menuImport: {
        updateMany: async (args) => {
          update = args;
          return { count: 1 };
        },
        findFirst: async () => record,
      },
    };
    const access = {
      assertCanManageChain: async () => undefined,
      assertCanAccessChain: async () => undefined,
    };
    const service = new MenuImportsService(prisma, access);

    const result = await service.updateDraft('chain-1', 'import-1', draft, owner);

    assert.equal(result.id, 'import-1');
    assert.equal(update.where.status, 'WAITING_REVIEW');
    assert.deepEqual(update.data.draft, draft);
    assert.equal('menuItem' in prisma, false);
  });

  it('marks OCR/AI failures as FAILED without touching the menu', async () => {
    let failedUpdate;
    const prisma = {
      menuImport: {
        findUnique: async () => ({
          id: 'import-1',
          chainId: 'chain-1',
          status: 'PROCESSING',
          imageUrls: ['/uploads/menu/import-test.png'],
        }),
        updateMany: async (args) => {
          failedUpdate = args;
          return { count: 1 };
        },
      },
    };
    const service = new MenuImportsService(prisma, {});
    service.runOcr = async () => {
      throw new Error('OCR unavailable');
    };

    await service.process('import-1');

    assert.equal(failedUpdate.data.status, 'FAILED');
    assert.match(failedUpdate.data.errorReason, /OCR unavailable/);
    assert.equal('menuItem' in prisma, false);
  });

  it('commits a reviewed draft once and records skipped rows in the audit result', async () => {
    const auditRows = [];
    const imported = [];
    const tx = {
      $queryRaw: async () => [],
      menuImport: {
        findFirst: async () => ({
          id: 'import-1',
          chainId: 'chain-1',
          status: 'WAITING_REVIEW',
          expiresAt: new Date(Date.now() + 60_000),
          draft,
        }),
        update: async ({ data }) => {
          imported.push(data);
          return { id: 'import-1', ...data };
        },
      },
      branch: { findMany: async () => [{ id: 'branch-1' }] },
      menuCategory: {
        findFirst: async () => ({ id: 'category-1', name: 'Cà phê' }),
      },
      branchAuditLog: {
        create: async ({ data }) => {
          auditRows.push(data);
          return data;
        },
      },
    };
    const prisma = { $transaction: async (work) => work(tx) };
    const access = { assertCanManageChain: async () => undefined };
    const service = new MenuImportsService(prisma, access);

    const result = await service.commit('chain-1', 'import-1', owner);

    assert.equal(result.status, 'IMPORTED');
    assert.deepEqual(imported[0].result, { created: 0, updated: 0, skipped: 1 });
    assert.equal(auditRows[0].action, 'MENU_IMPORT_COMMITTED');
    assert.equal('menuItem' in tx, false);
  });
});
