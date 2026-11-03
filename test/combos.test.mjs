import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CombosService, validateCombo } from '../dist/modules/menu/combos.service.js';
import { Prisma } from '../dist/generated/prisma/client.js';
const choices = [
  { menuItemId: 'tea', surcharge: 0, isDefault: true },
  { menuItemId: 'matcha', surcharge: 5000, isDefault: false },
];
const components = () => [
  {
    id: 'bread-part',
    name: 'Bread',
    type: 'FIXED',
    quantity: 1,
    choices: [{ menuItemId: 'bread', surcharge: 0, isDefault: true }],
  },
  { id: 'drink-part', name: 'Drink', type: 'CHOICE', quantity: 1, choices },
];
test('combo cardinalities, quantity, default choice and surcharge are enforced', () => {
  validateCombo(components());
  for (const mutate of [
    (c) => c.splice(0, 1),
    (c) => (c[0].quantity = 0),
    (c) => (c[0].quantity = 6),
    (c) => (c[0].quantity = 1.5),
    (c) => (c[1].choices = [choices[0]]),
    (c) => (c[1].choices = [...choices, { ...choices[0] }]),
    (c) => (c[1].choices = choices.map((x) => ({ ...x, isDefault: false }))),
    (c) => (c[1].choices = [{ ...choices[0], surcharge: -1 }, choices[1]]),
  ]) {
    const c = structuredClone(components());
    mutate(c);
    assert.throws(() => validateCombo(c));
  }
});
function fixture(change = () => {}) {
  const row = {
    isEnabled: true,
    isAvailable: true,
    priceOverride: null,
    combo: {
      id: 'combo',
      name: 'Breakfast',
      price: new Prisma.Decimal(39000),
      isActive: true,
      deletedAt: null,
      components: components(),
    },
  };
  change(row);
  const tx = {
    branchCombo: { findUnique: async () => row },
    menuOption: {
      findMany: async () => [
        { id: 'size-m', code: 'M' },
        { id: 'size-l', code: 'L' },
      ],
    },
  };
  const service = new CombosService({}, {}, {});
  const price = async (dto) => ({
    itemName: dto.menuItemId,
    basePrice: new Prisma.Decimal(80000),
    unitPrice: new Prisma.Decimal(80000 + (dto.extras?.[0]?.quantity ?? 0) * 5000),
    selectedOptions: [],
  });
  return { service, tx, price };
}
test('combo uses parent price, surcharge and per-unit extras; component menu price is excluded', async () => {
  const { service, tx, price } = fixture();
  const result = await service.price(
    tx,
    'branch',
    {
      comboId: 'combo',
      quantity: 2,
      components: [
        {
          componentId: 'drink-part',
          menuItemId: 'matcha',
          extras: [{ extraId: 'pearl', quantity: 1 }],
        },
      ],
    },
    price,
  );
  assert.equal(result.unitPrice.toString(), '49000');
  assert.deepEqual(
    result.children.map((x) => x.quantity),
    [2, 2],
  );
});
test('zero override is a valid combo base price', async () => {
  const { service, tx, price } = fixture((r) => (r.priceOverride = new Prisma.Decimal(0)));
  assert.equal(
    (
      await service.price(tx, 'branch', { comboId: 'combo', quantity: 1, components: [] }, price)
    ).unitPrice.toString(),
    '0',
  );
});
test('reject hidden combo, unknown/duplicate component, foreign choice and fractional quantity', async () => {
  const { service, tx, price } = fixture();
  for (const input of [
    { quantity: 1, components: [{ componentId: 'other' }] },
    { quantity: 1, components: [{ componentId: 'drink-part' }, { componentId: 'drink-part' }] },
    { quantity: 1, components: [{ componentId: 'drink-part', menuItemId: 'foreign' }] },
    { quantity: 1.5, components: [] },
  ])
    await assert.rejects(service.price(tx, 'branch', { comboId: 'combo', ...input }, price));
  const hidden = fixture((r) => (r.combo.isActive = false));
  await assert.rejects(
    hidden.service.price(hidden.tx, 'branch', { comboId: 'combo', quantity: 1 }, hidden.price),
  );
});
test('fixed size is injected and conflicting size is rejected', async () => {
  const { service, tx, price } = fixture((r) => (r.combo.components[1].fixedSizeCode = 'M'));
  let seen;
  await service.price(
    tx,
    'branch',
    { comboId: 'combo', quantity: 1, components: [] },
    async (dto) => {
      if (dto.menuItemId === 'tea') seen = dto.optionIds;
      return price(dto);
    },
  );
  assert.deepEqual(seen, ['size-m']);
  await assert.rejects(
    service.price(
      tx,
      'branch',
      {
        comboId: 'combo',
        quantity: 1,
        components: [{ componentId: 'drink-part', optionIds: ['size-l'] }],
      },
      price,
    ),
  );
});

import { CounterOperationsService } from '../dist/modules/counter-operations/counter-operations.service.js';
test('new database drafts are retired; checkout is the only cart submission path', async () => {
  const service = new CounterOperationsService(
    {},
    { assertSubscriptionAllowsWrite: async () => {} },
    {},
  );
  await assert.rejects(
    service.createDraft({ branchId: 'branch', employeeId: 'employee' }, {}),
    (error) => error.getStatus() === 410,
  );
});
