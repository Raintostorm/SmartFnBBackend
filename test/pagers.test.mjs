import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PagersService } from '../dist/modules/counter-operations/pagers.service.js';
const actor = { role: 'CASHIER', branchId: 'branch', employeeId: 'staff' };
function fixture(overrides = {}) {
  const events = [];
  const order = {
    id: 'order',
    branchId: 'branch',
    status: 'SUBMITTED',
    paymentStatus: 'PAID',
    pagerNumber: null,
    pagerNotifiedAt: null,
    ...overrides,
  };
  const tx = {
    $queryRaw: async () => [],
    order: {
      findFirst: async ({ where }) => (where.branchId === order.branchId ? order : null),
      update: async ({ data }) => Object.assign(order, data),
    },
  };
  const service = new PagersService(
    { $transaction: async (fn) => fn(tx) },
    { assertCanAccessBranch: async () => {}, assertSubscriptionAllowsWrite: async () => {} },
    { branch: (...args) => events.push(args) },
  );
  return { service, order, events };
}
test('assign/change/remove a pager; changing clears previous notification', async () => {
  const { service, order } = fixture({ pagerNumber: 1, pagerNotifiedAt: new Date() });
  await service.change(actor, 'order', 2);
  assert.equal(order.pagerNumber, 2);
  assert.equal(order.pagerNotifiedAt, null);
  await service.change(actor, 'order', null);
  assert.equal(order.pagerNumber, null);
});
test('reject unpaid/closed orders and out of range/fractional numbers', async () => {
  for (const overrides of [
    { paymentStatus: 'UNPAID' },
    { status: 'COMPLETED' },
    { status: 'CANCELLED' },
  ])
    await assert.rejects(fixture(overrides).service.change(actor, 'order', 1));
  for (const number of [0, 1000, 1.5, undefined])
    await assert.rejects(fixture().service.change(actor, 'order', number));
});
test('reject another branch and unauthorized roles before publishing', async () => {
  const { service, events } = fixture();
  await assert.rejects(
    service.change({ ...actor, branchId: 'other' }, 'order', 1),
    (e) => e.getStatus() === 404,
  );
  for (const role of ['BARISTA', 'OWNER'])
    await assert.rejects(
      service.change({ ...actor, role }, 'order', 1),
      (e) => e.getStatus() === 403,
    );
  assert.equal(events.length, 0);
});
test('notify requires ready state and matching current pager, and is idempotent', async () => {
  const { service, order } = fixture({ status: 'READY', pagerNumber: 23 });
  const barista = { ...actor, role: 'BARISTA' };
  await assert.rejects(service.change(barista, 'order', 24, true));
  await service.change(barista, 'order', 23, true);
  const first = order.pagerNotifiedAt;
  await service.change(barista, 'order', 23, true);
  assert.equal(order.pagerNotifiedAt, first);
  await assert.rejects(fixture({ pagerNumber: 23 }).service.change(barista, 'order', 23, true));
});
