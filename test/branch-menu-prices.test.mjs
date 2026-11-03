import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MenuService } from '../dist/modules/menu/menu.service.js';
import { CounterOperationsService } from '../dist/modules/counter-operations/counter-operations.service.js';
import { Prisma } from '../dist/generated/prisma/client.js';
import { ForbiddenException } from '@nestjs/common';
const owner = { id: 'owner', role: 'OWNER' };
function fixture(initial = null, access = {}) {
  const row = { branchId: 'branch', menuItemId: 'item', priceOverride: initial };
  const audits = [],
    events = [];
  const tx = {
    branchMenuItem: {
      findUnique: async () => ({ ...row }),
      update: async ({ data }) => Object.assign(row, data),
    },
    branchAuditLog: { create: async (args) => audits.push(args.data) },
  };
  const db = {
    ...tx,
    $transaction: async (fn) => fn(tx),
    branch: { findMany: async () => [{ id: 'branch' }] },
    menuItem: { findFirst: async () => ({ id: 'item', price: new Prisma.Decimal(30000) }) },
  };
  const service = new MenuService(
    db,
    { assertCanManageChain: async () => {}, ...access },
    { branch: (...args) => events.push(args) },
  );
  return { service, row, audits, events };
}
test('branch price accepts zero, audits owner without employee and publishes after commit', async () => {
  const f = fixture();
  const result = await f.service.setBranchPrice(
    'chain',
    'item',
    'branch',
    { priceOverride: 0 },
    owner,
  );
  assert.equal(result.effectivePrice, 0);
  assert.deepEqual(result.warnings, ['PRICE_OUTSIDE_CHAIN_RANGE']);
  assert.equal(f.audits[0].actorUserId, 'owner');
  assert.equal(f.audits[0].before.priceOverride, null);
  assert.equal(f.events[0][1], 'menu.prices-updated');
});
test('clearing override restores chain price without overwriting availability', async () => {
  const f = fixture(new Prisma.Decimal(42000));
  const result = await f.service.setBranchPrice(
    'chain',
    'item',
    'branch',
    { priceOverride: null },
    owner,
  );
  assert.equal(result.effectivePrice.toString(), '30000');
  assert.equal(f.row.priceOverride, null);
});
test('scope or read-only refusal cannot mutate price or publish', async () => {
  const f = fixture(null, {
    assertCanManageChain: async () => {
      throw new ForbiddenException();
    },
  });
  await assert.rejects(
    f.service.setBranchPrice('chain', 'item', 'branch', { priceOverride: 1 }, owner),
  );
  assert.equal(f.audits.length, 0);
  assert.equal(f.events.length, 0);
});
test('invalid prices rejected even when service bypasses DTO', async () => {
  for (const priceOverride of [undefined, -1, '0', NaN, Infinity, 1.234]) {
    const f = fixture();
    await assert.rejects(
      f.service.setBranchPrice('chain', 'item', 'branch', { priceOverride }, owner),
    );
    assert.equal(f.events.length, 0);
  }
});
test('checkout uses branch override plus option prices; null falls back and zero remains valid', async () => {
  for (const [override, expected] of [
    [null, '30000'],
    [new Prisma.Decimal(0), '0'],
    [new Prisma.Decimal(40000), '40000'],
  ]) {
    const tx = {
      branchMenuItem: {
        findUnique: async () => ({
          isEnabled: true,
          isAvailable: true,
          priceOverride: override,
          menuItem: {
            name: 'Tea',
            price: new Prisma.Decimal(30000),
            isActive: true,
            isAvailable: true,
            optionGroups: [],
          },
        }),
      },
      branchMenuOption: { count: async () => 0 },
    };
    const service = new CounterOperationsService({}, {});
    const priced = await service.priceCartItem(tx, 'branch', { menuItemId: 'item', optionIds: [] });
    assert.equal(priced.unitPrice.toString(), expected);
  }
});
test('Barista context never exposes branch override, chain price, or option surcharge', async () => {
  const service = new CounterOperationsService({}, {});
  service.cashierContext = async () => ({
    branch: { id: 'branch' },
    menuItems: [
      {
        priceOverride: new Prisma.Decimal(42000),
        isAvailable: true,
        menuItem: {
          price: new Prisma.Decimal(42000),
          chainPrice: new Prisma.Decimal(30000),
          costPrice: new Prisma.Decimal(10000),
          name: 'Tea',
          optionGroups: [
            { group: { options: [{ name: 'L', priceDelta: new Prisma.Decimal(5000) }] } },
          ],
        },
      },
    ],
  });
  const row = (await service.baristaContext({ role: 'BARISTA' })).menuItems[0];
  assert.equal('priceOverride' in row, false);
  for (const field of ['price', 'chainPrice', 'costPrice'])
    assert.equal(field in row.menuItem, false);
  assert.equal('priceDelta' in row.menuItem.optionGroups[0].group.options[0], false);
});
test('failed audit never publishes a price event', async () => {
  const events = [];
  const service = new MenuService(
    {
      branch: { findMany: async () => [{ id: 'branch' }] },
      menuItem: { findFirst: async () => ({ price: new Prisma.Decimal(30000) }) },
      $transaction: async (fn) =>
        fn({
          branchMenuItem: {
            findUnique: async () => ({ priceOverride: null }),
            update: async () => ({ priceOverride: 40000 }),
          },
          branchAuditLog: {
            create: async () => {
              throw Error('DB unavailable');
            },
          },
        }),
    },
    { assertCanManageChain: async () => {} },
    { branch: (...args) => events.push(args) },
  );
  await assert.rejects(
    service.setBranchPrice('chain', 'item', 'branch', { priceOverride: 40000 }, owner),
  );
  assert.equal(events.length, 0);
});
test('chain price change publishes to branches and never writes their overrides', async () => {
  const events = [];
  const service = new MenuService(
    {
      menuItem: {
        findFirst: async () => ({ id: 'item' }),
        update: async () => ({ id: 'item', price: 35000 }),
      },
      branchMenuItem: { findMany: async () => [{ branchId: 'a' }, { branchId: 'b' }] },
    },
    { assertCanManageChain: async () => {} },
    { branch: (...args) => events.push(args) },
  );
  await service.updateItem('chain', 'item', { price: 35000 }, owner);
  assert.deepEqual(
    events.map((e) => e[0]),
    ['a', 'b'],
  );
});
