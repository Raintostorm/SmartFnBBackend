import 'reflect-metadata';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ValidationPipe } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { assignWholeMenuToBranch } from '../dist/modules/menu/whole-menu.js';
import { BranchesService } from '../dist/modules/branches/branches.service.js';
import { MenuService } from '../dist/modules/menu/menu.service.js';
import { ChainMenuController } from '../dist/modules/menu/chain-menu.controller.js';
import { CreateBranchDto, UpdateBranchDto } from '../dist/modules/branches/dto/branch.dto.js';

const owner = { id: 'u-owner', role: 'OWNER', ownerId: 'owner-1' };
const BRANCH = '11111111-1111-4111-8111-111111111111';
const CHAIN = '22222222-2222-4222-8222-222222222222';

function menuTx({ items = ['i1', 'i2', 'i3'], combos = ['c1'], enabledItems = ['i1'], enabledCombos = [] } = {}) {
  const calls = { itemWhere: null, comboWhere: null, updates: [], creates: [], audits: [] };
  const tx = {
    menuItem: { findMany: async ({ where }) => ((calls.itemWhere = where), items.map((id) => ({ id }))) },
    combo: { findMany: async ({ where }) => ((calls.comboWhere = where), combos.map((id) => ({ id }))) },
    branchMenuItem: {
      findMany: async () => enabledItems.map((menuItemId) => ({ menuItemId })),
      updateMany: async (args) => (calls.updates.push(['item', args]), { count: 0 }),
      createMany: async (args) => (calls.creates.push(['item', args]), { count: 0 }),
    },
    branchCombo: {
      findMany: async () => enabledCombos.map((comboId) => ({ comboId })),
      updateMany: async (args) => (calls.updates.push(['combo', args]), { count: 0 }),
      createMany: async (args) => (calls.creates.push(['combo', args]), { count: 0 }),
    },
    chainAuditLog: { create: async ({ data }) => (calls.audits.push(data), data) },
  };
  return { tx, calls };
}

describe('Sell the whole menu at one branch', () => {
  it('switches on every item and combo of the chain, keeping existing rows (and their branch price)', async () => {
    const { tx, calls } = menuTx();
    const result = await assignWholeMenuToBranch(tx, owner, CHAIN, BRANCH);
    assert.deepEqual(result, { branchId: BRANCH, items: 3, combos: 1, addedItems: 2, addedCombos: 1 });
    assert.deepEqual(calls.itemWhere, { deletedAt: null, category: { chainId: CHAIN, deletedAt: null } });
    assert.deepEqual(calls.comboWhere, { chainId: CHAIN, deletedAt: null });
    // Disabled rows are switched back on (price untouched), missing rows are created; duplicates skipped.
    assert.deepEqual(calls.updates[0][1], { where: { branchId: BRANCH, menuItemId: { in: ['i1', 'i2', 'i3'] }, isEnabled: false }, data: { isEnabled: true } });
    assert.deepEqual(calls.creates[0][1], { data: ['i1', 'i2', 'i3'].map((menuItemId) => ({ branchId: BRANCH, menuItemId })), skipDuplicates: true });
    assert.deepEqual(calls.creates[1][1], { data: [{ branchId: BRANCH, comboId: 'c1' }], skipDuplicates: true });
    assert.equal(calls.audits.length, 1);
    assert.equal(calls.audits[0].action, 'BRANCH_WHOLE_MENU_ASSIGNED');
    assert.equal(calls.audits[0].entityId, BRANCH);
  });

  it('does nothing but audit when the chain has no menu yet', async () => {
    const { tx, calls } = menuTx({ items: [], combos: [], enabledItems: [] });
    const result = await assignWholeMenuToBranch(tx, owner, CHAIN, BRANCH);
    assert.deepEqual(result, { branchId: BRANCH, items: 0, combos: 0, addedItems: 0, addedCombos: 0 });
    assert.equal(calls.updates.length + calls.creates.length, 0);
  });

  it('a new branch can take the whole menu in the same transaction it is created in', async () => {
    const { tx, calls } = menuTx();
    let created;
    const branch = { count: async () => 0, create: async (args) => ((created = args), { id: BRANCH }) };
    const service = new BranchesService(
      { restaurantChain: { count: async () => 1 }, branch, $transaction: async (work) => work({ ...tx, branch }) },
      { assertCanManageChain: async () => undefined },
      { getActivePlan: async () => ({}), assertCanAdd: async () => async () => undefined },
    );
    const dto = { code: 'HCM-D2', name: 'Chi nhánh 2', addressLine1: '2 Lê Lợi', city: 'Hồ Chí Minh' };
    await service.createBranch(CHAIN, { ...dto, assignWholeMenu: true }, owner);
    assert.equal(created.data.assignWholeMenu, undefined, 'flag never reaches the branch row');
    assert.equal(calls.audits[0].action, 'BRANCH_WHOLE_MENU_ASSIGNED');

    const quiet = menuTx();
    const plain = new BranchesService(
      { restaurantChain: { count: async () => 1 }, branch, $transaction: async (work) => work({ ...quiet.tx, branch }) },
      { assertCanManageChain: async () => undefined },
      { getActivePlan: async () => ({}), assertCanAdd: async () => async () => undefined },
    );
    await plain.createBranch(CHAIN, dto, owner);
    assert.equal(quiet.calls.audits.length, 0, 'without the flag the new branch sells nothing yet');
  });

  it('the menu route refuses a branch of another chain and reloads the branch menu', async () => {
    const events = [];
    const { tx } = menuTx();
    const prisma = {
      branch: { findMany: async ({ where }) => (where.id.in.includes(BRANCH) ? [{ id: BRANCH }] : []) },
      $transaction: async (work) => work(tx),
    };
    const service = new MenuService(prisma, { assertCanManageChain: async () => undefined }, { branch: (id, type, data) => events.push({ id, type, data }) });
    const result = await service.assignWholeMenu(CHAIN, BRANCH, owner);
    assert.equal(result.items, 3);
    assert.deepEqual(events, [{ id: BRANCH, type: 'menu.prices-updated', data: { wholeMenu: true } }]);
    await assert.rejects(service.assignWholeMenu(CHAIN, '33333333-3333-4333-8333-333333333333', owner), (e) => e?.getStatus?.() === 400);
  });

  it('exposes POST restaurant-chains/:chainId/menu/branches/:branchId/assign-all and the create flag', async () => {
    const handler = ChainMenuController.prototype.assignWholeMenu;
    assert.equal(Reflect.getMetadata(METHOD_METADATA, handler), 1);
    assert.equal(Reflect.getMetadata(PATH_METADATA, handler), 'branches/:branchId/assign-all');
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
    const dto = { code: 'HCM-D3', name: 'Chi nhánh 3', addressLine1: '3 Hai Bà Trưng', city: 'Hồ Chí Minh', assignWholeMenu: true };
    assert.equal((await pipe.transform(dto, { type: 'body', metatype: CreateBranchDto })).assignWholeMenu, true);
    await assert.rejects(pipe.transform({ ...dto, assignWholeMenu: 'yes' }, { type: 'body', metatype: CreateBranchDto }));
    // Only at creation: editing a branch does not take the flag.
    await assert.rejects(pipe.transform({ assignWholeMenu: true }, { type: 'body', metatype: UpdateBranchDto }));
  });
});
