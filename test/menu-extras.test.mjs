import assert from 'node:assert/strict';
import { test } from 'node:test';
import { priceExtras } from '../dist/modules/menu/extra-pricing.js';
import { Prisma } from '../dist/generated/prisma/client.js';
const fixture = (overrides = {}) => ({
  menuItem: {
    findFirst: async () => ({
      maxExtras: 5,
      category: { chainId: 'chain' },
      extras: [
        {
          extraId: 'pearl',
          price: new Prisma.Decimal(5000),
          maxQuantity: 3,
          extra: {
            name: 'Trân châu',
            chainId: 'chain',
            isActive: true,
            branches: [],
            ...overrides,
          },
        },
      ],
    }),
  },
});
test('extra quantity is per cup; snapshot retains unit price and quantity', async () => {
  const result = await priceExtras(fixture(), 'branch', 'tea', [{ extraId: 'pearl', quantity: 2 }]);
  assert.equal(result.total.toString(), '10000');
  assert.equal(result.snapshots[0].unitPrice, '5000');
  assert.equal(result.snapshots[0].quantity, 2);
  assert.equal(result.snapshots[0].kind, 'EXTRA');
});
test('reject duplicate IDs, fraction, zero, over per-extra limit and unknown extras', async () => {
  for (const selected of [
    [{ extraId: 'pearl', quantity: 0 }],
    [{ extraId: 'pearl', quantity: 1.5 }],
    [{ extraId: 'pearl', quantity: 4 }],
    [{ extraId: 'other', quantity: 1 }],
    [
      { extraId: 'pearl', quantity: 1 },
      { extraId: 'pearl', quantity: 1 },
    ],
  ]) {
    await assert.rejects(priceExtras(fixture(), 'branch', 'tea', selected));
  }
});
test('reject disabled chain extra, sold-out branch extra and foreign chain link', async () => {
  for (const override of [
    { isActive: false },
    { branches: [{ isAvailable: false }] },
    { chainId: 'foreign' },
  ])
    await assert.rejects(
      priceExtras(fixture(override), 'branch', 'tea', [{ extraId: 'pearl', quantity: 1 }]),
    );
});
test('empty selection has zero price and needs no extra query', async () => {
  assert.equal((await priceExtras({}, 'branch', 'tea', [])).total.toString(), '0');
});
test('total limit is checked independently of per-extra maximum', async () => {
  const tx = fixture();
  const lookup = tx.menuItem.findFirst;
  tx.menuItem.findFirst = async () => ({ ...(await lookup()), maxExtras: 1 });
  await assert.rejects(priceExtras(tx, 'branch', 'tea', [{ extraId: 'pearl', quantity: 2 }]));
});
import { MenuExtrasService } from '../dist/modules/menu/menu-extras.service.js';
const barista = { role: 'BARISTA', branchId: 'branch', id: 'user', employeeId: 'employee' };
const access = {
  assertCanAccessBranch: async () => {},
  assertSubscriptionAllowsWrite: async () => {},
  assertCanManageChain: async () => {},
};
test('cashier cannot change extra availability even by directly invoking service', async () => {
  const service = new MenuExtrasService({}, access, {});
  await assert.rejects(service.availability({ ...barista, role: 'CASHIER' }, 'pearl', false));
});
test('barista cannot enable an extra disabled by the chain', async () => {
  const service = new MenuExtrasService(
    { menuExtra: { findFirst: async () => ({ isActive: false }) } },
    access,
    {},
  );
  await assert.rejects(service.availability(barista, 'pearl', true));
});
test('extra assignment rejects another chain before replacing item links', async () => {
  let writes = 0;
  const tx = {
    menuItem: { findFirst: async () => ({ id: 'tea' }), update: async () => writes++ },
    menuExtra: { count: async () => 0 },
  };
  const service = new MenuExtrasService({ $transaction: async (fn) => fn(tx) }, access, {});
  await assert.rejects(
    service.assign(
      'chain',
      'tea',
      { maxExtras: 5, extras: [{ extraId: 'foreign', price: 5000, maxQuantity: 3 }] },
      { role: 'OWNER' },
    ),
  );
  assert.equal(writes, 0);
});
