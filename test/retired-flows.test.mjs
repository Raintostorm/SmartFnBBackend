import 'reflect-metadata';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { MODULE_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { AppModule } from '../dist/app.module.js';
import { isAppRole } from '../dist/modules/auth/app-role.enum.js';

it('registers counter and refund operations without retired table-service routes', () => {
  const seen = new Set();
  const routes = [];
  function visit(value) {
    const mod = value?.module ?? value;
    if (!mod || seen.has(mod)) return;
    seen.add(mod);
    const controllers = Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, mod) ?? [];
    for (const controller of controllers) {
      const prefix = Reflect.getMetadata(PATH_METADATA, controller) ?? '';
      for (const name of Object.getOwnPropertyNames(controller.prototype)) {
        if (name === 'constructor') continue;
        const path = Reflect.getMetadata(PATH_METADATA, controller.prototype[name]);
        if (path !== undefined)
          routes.push(`${prefix}/${path}`.replace(/\/{2,}/g, '/').replace(/^\//, ''));
      }
    }
    for (const child of Reflect.getMetadata(MODULE_METADATA.IMPORTS, mod) ?? []) visit(child);
  }
  visit(AppModule);
  assert.ok(routes.some((r) => r.startsWith('cashier/')));
  assert.ok(routes.some((r) => r.startsWith('barista/')));
  assert.ok(routes.some((r) => r.includes('payments/') && r.endsWith('/confirm')));
  assert.ok(routes.some((r) => r === 'cashier/orders/:orderId/refunds'));
  assert.ok(routes.some((r) => r === 'manager/refund-approval-requests/:requestId/approve'));
  assert.ok(routes.some((r) => r === 'manager/refund-approval-requests/:requestId/reject'));
  assert.ok(routes.some((r) => r === 'cashier/refund-approval-requests/:requestId/complete'));
  assert.ok(!routes.some((r) => r === 'manager/orders/:orderId/cancel-paid'));
  assert.ok(!routes.some((r) => r === 'refunds/:refundId/complete'));
  assert.deepEqual(
    routes.filter((r) =>
      /^(tables|table-sessions|reservations|invoices|waiter|kitchen|attendance|shift-templates|work-sessions)(\/|$)/.test(r),
    ),
    [],
  );
});

it('rejects retired WAITER and KITCHEN identities at authentication boundaries', () => {
  assert.equal(isAppRole('WAITER'), false);
  assert.equal(isAppRole('KITCHEN'), false);
  assert.equal(isAppRole('CASHIER'), true);
  assert.equal(isAppRole('BARISTA'), true);
});
