import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ReportsService } from '../dist/modules/reports/reports.service.js';
import { ManagerReportsService } from '../dist/modules/branch-manager/manager-reports.service.js';

const owner = { id: 'user-owner', role: 'OWNER', ownerId: 'owner-id', branchId: null, chainIds: ['chain-one'] };
const branch = { id: 'branch-one', code: 'B1', name: 'Branch 1', city: 'HCM', chainId: 'chain-one', chain: { timezone: 'Asia/Ho_Chi_Minh' } };
const sqlOf = (strings) => strings.join('?');

test('owner cancellations section counts by cancel time, refunds by cancel date, and names who refunded', async () => {
  const queries = [];
  const report = new ReportsService(
    {
      branch: { findMany: async () => [branch] },
      $queryRaw: async (strings, ...values) => {
        queries.push({ sql: sqlOf(strings), values });
        return queries.length === 1
          ? [{ total: 3, paid_count: 2, refunds: '150000', pending: '50000' }]
          : [{ id: 'o1', orderCode: 'A-1', branch: { id: 'branch-one', name: 'Branch 1' }, refunds: [{ amount: '100000', completedBy: { firstName: 'Lan', lastName: 'Tran' } }] }];
      },
    },
    { getAccessibleBranchIds: async () => ['branch-one'] },
    { assertFeatureEnabled: async () => undefined },
  );
  const result = await report.getCancellations(owner, { from: '2026-11-01', to: '2026-11-07', limit: 10 });
  assert.equal(result.total, 3);
  assert.equal(result.paidCancellationCount, 2);
  assert.equal(result.refundAmount, '150000.00');
  assert.equal(result.pendingRefundAmount, '50000.00');
  assert.equal(result.items[0].refunds[0].completedBy.firstName, 'Lan');
  // Refunds follow BR-50 (cancellation date), the list follows the cancellation instant, scoped to allowed branches.
  assert.match(queries[0].sql, /cancellation_date >= \?::date/);
  assert.match(queries[1].sql, /cancelled_at >= \?/);
  assert.match(queries[1].sql, /completed_by_employee_id/);
  assert.ok(queries.every((q) => q.values.some((v) => Array.isArray(v) && v.includes('branch-one'))));
  assert.equal(queries[1].values.at(-1), 10);
});

test('store report returns cash per day next to cash per cashier, and AOV ignores refunds of earlier days', async () => {
  const sqls = [];
  const tx = {
    $queryRaw: async (strings) => {
      const sql = sqlOf(strings);
      sqls.push(sql);
      if (sql.includes('AS "averageOrderValue"')) return [{ grossRevenue: '0', orderCount: 0 }];
      if (sql.includes('"averageSeconds"')) return [{ averageSeconds: null, completedUnits: 0 }];
      if (sql.includes('AS "paidCancellationCount"')) return [{ total: 0, paidCancellationCount: 0, refundAmount: '0', pendingRefundAmount: '0' }];
      if (sql.includes('GROUP BY day')) return [{ day: '2026-11-02', cashCollected: '300000', cashRefunded: '50000', netCash: '250000' }];
      return [];
    },
  };
  const service = new ManagerReportsService(
    {
      branch: { findUniqueOrThrow: async () => ({ id: 'branch-one', name: 'Branch 1', timezone: 'Asia/Ho_Chi_Minh' }) },
      $transaction: async (work) => work(tx),
    },
    { assertCanAccessBranch: async () => undefined },
  );
  const manager = { id: 'u-m', role: 'MANAGER', branchId: 'branch-one', employeeId: 'e-m', chainIds: [] };
  const result = await service.report(manager, { from: '2026-11-01', to: '2026-11-07', granularity: 'day', limit: 10 });
  assert.deepEqual(result.cashByDay, [{ day: '2026-11-02', cashCollected: '300000', cashRefunded: '50000', netCash: '250000' }]);
  const summarySql = sqls.find((sql) => sql.includes('AS "averageOrderValue"'));
  assert.match(summarySql, /ROUND\(st\.completed \/ st\.orders, 2\)/);
  assert.doesNotMatch(summarySql, /ROUND\(\(st\.gross - rt\.total\) \/ st\.orders/);
});
