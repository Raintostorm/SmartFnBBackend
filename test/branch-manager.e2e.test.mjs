import 'reflect-metadata';
import assert from 'node:assert/strict';
import { before, after, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../dist/app.module.js';
import { configureApplication } from '../dist/app.setup.js';
import { configureSwagger } from '../dist/swagger.setup.js';
import { PrismaService } from '../dist/database/prisma.service.js';
import { PasswordService } from '../dist/modules/auth/password.service.js';

if (!new URL(process.env.DATABASE_URL).pathname.startsWith('/smart_fnb_manager_test_'))
  throw new Error('Use scripts/test-manager.mjs with an isolated database');

describe('Branch Manager API and PostgreSQL integration', () => {
  let app,
    db,
    base,
    plan,
    chain,
    branch,
    otherBranch,
    manager,
    otherManager,
    cashier,
    barista,
    option,
    item,
    group;
  let managerToken, otherToken, cashierToken, baristaToken, createdStaff;
  const password = 'StrongPass123';
  async function api(path, token, method = 'GET', data) {
    const response = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const body = await response.json();
    return { status: response.status, body };
  }
  async function login(email, pwd = password) {
    const result = await api('/auth/login', null, 'POST', { email, password: pwd });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body.accessToken;
  }
  const staffData = (role = 'CASHIER') => ({
    email: `${randomUUID()}@example.com`,
    employeeCode: randomUUID(),
    firstName: 'Test',
    lastName: 'Staff',
    role,
    password,
  });

  async function makeOrder(branchId, extra = {}) {
    return db.order.create({
      data: {
        orderCode: randomUUID(),
        branchId,
        type: 'COUNTER_PICKUP',
        status: 'CONFIRMED',
        totalAmount: 100,
        subtotal: 100,
        createdByCashierId: cashier.id,
        items: {
          create: {
            menuItemId: item.id,
            itemName: 'Historic coffee',
            unitPrice: 50,
            quantity: 2,
            totalPrice: 100,
            selectedOptions: [
              {
                id: option.id,
                name: 'Historic pearl',
                groupCode: 'TOPPING',
                groupName: 'Toppings',
                priceDelta: '5',
              },
            ],
          },
        },
        ...extra,
      },
      include: { items: true },
    });
  }

  before(async () => {
    app = await NestFactory.create(AppModule, { logger: false });
    configureApplication(app);
    configureSwagger(app);
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${app.getHttpServer().address().port}`;
    db = app.get(PrismaService);
    const roles = {};
    for (const role of ['MANAGER', 'CASHIER', 'BARISTA', 'ADMIN', 'OWNER']) {
      roles[role] = await db.role.upsert({
        where: { code: role },
        create: { code: role, name: role },
        update: {},
      });
    }
    plan = await db.servicePlan.create({
      data: {
        code: randomUUID(),
        name: 'Test plan',
        monthlyPrice: 1,
        maxBranches: 5,
        maxAccounts: 30,
        maxTables: 20,
      },
    });
    chain = await db.restaurantChain.create({
      data: {
        code: randomUUID(),
        name: 'Manager test chain',
        subscription: {
          create: {
            planId: plan.id,
            monthlyPrice: 1,
            startsAt: new Date(),
            expiresAt: new Date(Date.now() + 86400000 * 30),
          },
        },
      },
    });
    branch = await db.branch.create({
      data: {
        chainId: chain.id,
        code: randomUUID(),
        name: 'Branch A',
        city: 'HCM',
        addressLine1: 'Address',
      },
    });
    otherBranch = await db.branch.create({
      data: {
        chainId: chain.id,
        code: randomUUID(),
        name: 'Branch B',
        city: 'HCM',
        addressLine1: 'Address',
      },
    });
    const passwordHash = await app.get(PasswordService).hash(password);
    async function employee(role, branchId) {
      return db.employee.create({
        data: {
          branch: { connect: { id: branchId } },
          employeeCode: randomUUID(),
          firstName: 'Test',
          lastName: role,
          user: {
            create: { email: `${randomUUID()}@example.com`, passwordHash, roleId: roles[role].id },
          },
        },
        include: { user: true },
      });
    }
    manager = await employee('MANAGER', branch.id);
    otherManager = await employee('MANAGER', otherBranch.id);
    cashier = await employee('CASHIER', branch.id);
    barista = await employee('BARISTA', branch.id);
    managerToken = await login(manager.user.email);
    otherToken = await login(otherManager.user.email);
    cashierToken = await login(cashier.user.email);
    baristaToken = await login(barista.user.email);
    const category = await db.menuCategory.create({ data: { chainId: chain.id, name: 'Coffee' } });
    item = await db.menuItem.create({
      data: { categoryId: category.id, sku: randomUUID(), name: 'Current coffee', price: 50 },
    });
    group = await db.menuOptionGroup.create({
      data: { chainId: chain.id, code: 'TOPPING', name: 'Toppings' },
    });
    option = await db.menuOption.create({
      data: { groupId: group.id, code: 'PEARL', name: 'Pearl', priceDelta: 5 },
    });
  });
  after(async () => {
    await app?.close();
  });

  it('exposes manager contracts in Swagger and rejects unauthenticated/non-manager callers', async () => {
    const doc = await (await fetch(`${base}/api/docs-json`)).json();
    for (const path of [
      '/manager/staff',
      '/manager/menu-options/{optionId}/availability',
      '/manager/reports',
      '/manager/orders',
      '/manager/orders/{orderId}',
      '/manager/audit-logs',
    ]) {
      assert.ok(doc.paths[`/api/v1${path}`], path);
    }
    assert.equal((await api('/manager/orders')).status, 401);
    for (const token of [cashierToken, baristaToken])
      assert.equal((await api('/manager/reports', token)).status, 403);
    assert.equal(
      (
        await api(`/invoices/${randomUUID()}/cancel`, cashierToken, 'POST', {
          reason: 'Not allowed',
        })
      ).status,
      403,
    );
  });

  it('creates both staff roles without returning credentials or tokens', async () => {
    for (const role of ['CASHIER', 'BARISTA']) {
      const input = staffData(role);
      const r = await api('/manager/staff', managerToken, 'POST', input);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.branchId, branch.id);
      assert.equal(r.body.user.role.code, role);
      assert.equal(r.body.user.passwordHash, undefined);
      assert.equal(r.body.accessToken, undefined);
      assert.ok(await login(input.email));
      createdStaff = r.body;
    }
    assert.equal(
      (await api('/manager/staff', managerToken, 'POST', { ...staffData(), role: 'MANAGER' }))
        .status,
      400,
    );
    assert.equal(
      (
        await api('/manager/staff', managerToken, 'POST', {
          ...staffData(),
          branchId: otherBranch.id,
        })
      ).status,
      400,
    );
    const list = await api('/manager/staff?role=BARISTA&search=Staff&limit=1', managerToken);
    assert.equal(list.status, 200);
    assert.equal(list.body.items.length, 1);
    assert.equal(list.body.items[0].user.role.code, 'BARISTA');
  });

  it('blocks editing other branches and Manager accounts, and audits safe profile updates', async () => {
    assert.equal((await api(`/manager/staff/${createdStaff.id}`, otherToken)).status, 404);
    assert.equal(
      (
        await api(`/manager/staff/${createdStaff.id}`, otherToken, 'PATCH', {
          firstName: 'Intruder',
        })
      ).status,
      404,
    );
    assert.equal(
      (await api(`/manager/staff/${manager.id}`, managerToken, 'PATCH', { firstName: 'Intruder' }))
        .status,
      404,
    );
    assert.equal(
      (await api(`/manager/staff/${createdStaff.id}`, managerToken, 'PATCH', { firstName: null }))
        .status,
      400,
    );
    const r = await api(`/manager/staff/${createdStaff.id}`, managerToken, 'PATCH', {
      firstName: 'Changed',
      role: 'CASHIER',
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.user.role.code, 'CASHIER');
    const log = await db.branchAuditLog.findFirstOrThrow({
      where: { entityId: createdStaff.id, action: 'STAFF_UPDATED' },
    });
    assert.equal(log.actorUserId, manager.user.id);
    assert.equal(log.before.firstName, 'Test');
    assert.equal(log.after.firstName, 'Changed');
  });

  it('locks and resets passwords with session revocation and no password in audit', async () => {
    const token = await login(createdStaff.user.email);
    assert.equal(
      (
        await api(`/manager/staff/${createdStaff.id}/status`, managerToken, 'PATCH', {
          status: 'SUSPENDED',
          reason: '   ',
        })
      ).status,
      400,
    );
    const locked = await api(`/manager/staff/${createdStaff.id}/status`, managerToken, 'PATCH', {
      status: 'SUSPENDED',
      reason: 'Employee left',
    });
    assert.equal(locked.status, 200);
    assert.equal((await api('/auth/me', token)).status, 401);
    assert.equal(
      (
        await api(`/manager/staff/${createdStaff.id}/status`, managerToken, 'PATCH', {
          status: 'ACTIVE',
          reason: 'Returned to work',
        })
      ).status,
      200,
    );
    const oldToken = await login(createdStaff.user.email);
    const reset = await api(
      `/manager/staff/${createdStaff.id}/reset-password`,
      managerToken,
      'POST',
      { password: 'NewStrongPass456', reason: 'Forgot password' },
    );
    assert.equal(reset.status, 200);
    assert.equal((await api('/auth/me', oldToken)).status, 401);
    assert.equal(
      (await api('/auth/login', null, 'POST', { email: createdStaff.user.email, password })).status,
      401,
    );
    await login(createdStaff.user.email, 'NewStrongPass456');
    const logs = await db.branchAuditLog.findMany({ where: { entityId: createdStaff.id } });
    assert.doesNotMatch(JSON.stringify(logs), /NewStrongPass456|passwordHash|StrongPass123/);
  });

  it('enforces the chain-wide quota including concurrent hires from two branches', async () => {
    const count = await db.employee.count({ where: { branch: { chainId: chain.id } } });
    await db.servicePlan.update({ where: { id: plan.id }, data: { maxAccounts: count + 1 } });
    const results = await Promise.all([
      api('/manager/staff', managerToken, 'POST', staffData()),
      api('/manager/staff', otherToken, 'POST', staffData()),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
    assert.equal(await db.employee.count({ where: { branch: { chainId: chain.id } } }), count + 1);
    const denied = await api('/manager/staff', managerToken, 'POST', staffData());
    assert.equal(denied.status, 409);
    assert.equal(denied.body.error, 'PLAN_LIMIT_REACHED');
    await db.servicePlan.update({ where: { id: plan.id }, data: { maxAccounts: 30 } });
  });

  it('toggles only branch options, marks affected paid lines and preserves Owner disabled switches', async () => {
    const paid = await makeOrder(branch.id, { paymentStatus: 'PAID', status: 'SUBMITTED' });
    await db.orderItem.update({
      where: { id: paid.items[0].id },
      data: { status: 'QUEUED', units: { create: { sequence: 1, status: 'QUEUED' } } },
    });
    const result = await api(
      `/manager/menu-options/${option.id}/availability`,
      managerToken,
      'PATCH',
      { isAvailable: false },
    );
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.deepEqual(result.body.affectedOrderIds, [paid.id]);
    assert.equal(
      (await db.orderItem.findUnique({ where: { id: paid.items[0].id } })).status,
      'OUT_OF_STOCK',
    );
    assert.equal(
      await db.branchMenuOption.findUnique({
        where: { branchId_optionId: { branchId: otherBranch.id, optionId: option.id } },
      }),
      null,
    );
    await db.menuOption.update({ where: { id: option.id }, data: { isActive: false } });
    const on = await api(`/manager/menu-options/${option.id}/availability`, managerToken, 'PATCH', {
      isAvailable: true,
    });
    assert.equal(on.body.effectiveAvailable, false);
    assert.equal(
      (
        await api(`/manager/menu-options/${option.id}/availability`, managerToken, 'PATCH', {
          isAvailable: true,
          priceDelta: 999,
        })
      ).status,
      400,
    );
    await db.menuOption.update({ where: { id: option.id }, data: { isActive: true } });
  });

  it('searches all specified filters with pagination and returns immutable snapshots', async () => {
    const order = await makeOrder(branch.id, {
      callNumber: 321,
      businessDate: new Date('2026-10-01'),
      placedAt: new Date('2026-10-01T02:00:00Z'),
    });
    await db.payment.create({
      data: { paymentCode: randomUUID(), orderId: order.id, method: 'BANK_TRANSFER', amount: 100 },
    });
    const query = `search=321&orderCode=${order.orderCode.slice(0, 8)}&from=2026-10-01T00:00:00Z&to=2026-10-02T00:00:00Z&status=CONFIRMED&paymentStatus=UNPAID&paymentMethod=BANK_TRANSFER&type=COUNTER_PICKUP&limit=1`;
    const r = await api(`/manager/orders?${query}`, managerToken);
    assert.equal(r.status, 200);
    assert.equal(r.body.total, 1);
    assert.equal(r.body.items[0].id, order.id);
    const detail = await api(`/manager/orders/${order.id}`, managerToken);
    assert.equal(detail.body.items[0].itemName, 'Historic coffee');
    assert.equal(detail.body.items[0].selectedOptions[0].name, 'Historic pearl');
    assert.equal(detail.body.createdByCashier.id, cashier.id);
    assert.equal(detail.body.payments.length, 1);
    assert.equal((await api(`/manager/orders/${order.id}`, otherToken)).status, 404);
    assert.equal(
      (await api(`/manager/orders?branchId=${otherBranch.id}`, managerToken)).status,
      400,
    );
    assert.equal(
      (await api('/manager/orders?from=2026-10-02&to=2026-10-01', managerToken)).status,
      400,
    );
  });

  it('requires manager and reason for non-cash, audits variance and queues the counter order exactly once', async () => {
    const order = await makeOrder(branch.id);
    const payment = await db.payment.create({
      data: {
        paymentCode: randomUUID(),
        orderId: order.id,
        method: 'BANK_TRANSFER',
        provider: 'PAYOS',
        amount: 100,
      },
    });
    const path = `/payments/${payment.id}/confirm`;
    const input = {
      reason: 'Verified transfer with bank; accepted short payment',
      receivedAmount: 80,
      transactionRef: 'BANK-TEST-001',
    };
    assert.equal((await api(path, cashierToken, 'POST', input)).status, 403);
    assert.equal((await api(path, otherToken, 'POST', input)).status, 403);
    assert.equal((await api(path, managerToken, 'POST', {})).status, 400);
    assert.equal(
      (await api(path, managerToken, 'POST', { reason: '   ', receivedAmount: 100 })).status,
      400,
    );
    const r = await api(path, managerToken, 'POST', input);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.receivedAmount, '80');
    assert.equal(r.body.processedById, manager.id);
    assert.ok(r.body.confirmedAt);
    assert.equal(r.body.confirmationReason, input.reason);
    const updated = await db.order.findUnique({
      where: { id: order.id },
      include: { items: { include: { units: true } } },
    });
    assert.equal(updated.status, 'SUBMITTED');
    assert.equal(updated.paymentStatus, 'PAID');
    assert.ok(updated.callNumber);
    assert.equal(updated.items[0].units.length, 2);
    const log = await db.branchAuditLog.findFirstOrThrow({
      where: { entityId: payment.id, action: 'PAYMENT_MANUALLY_CONFIRMED' },
    });
    assert.equal(log.after.variance, '-20');
    assert.equal(log.actorEmployeeId, manager.id);
    assert.equal((await api(path, managerToken, 'POST', input)).status, 409);
    assert.equal(await db.branchAuditLog.count({ where: { entityId: payment.id } }), 1);
    const detail = await api(`/manager/orders/${order.id}`, managerToken);
    assert.equal(detail.body.audit.length, 1);
  });

  it('rolls back a losing concurrent confirmation including audit and preparation units', async () => {
    const order = await makeOrder(branch.id);
    const payment = await db.payment.create({
      data: { paymentCode: randomUUID(), orderId: order.id, method: 'BANK_TRANSFER', amount: 100 },
    });
    const replies = await Promise.all(
      [1, 2].map(() =>
        api(`/payments/${payment.id}/confirm`, managerToken, 'POST', {
          reason: 'Verified bank transfer',
          receivedAmount: 100,
        }),
      ),
    );
    assert.deepEqual(replies.map((r) => r.status).sort(), [200, 409]);
    assert.equal(await db.orderItemUnit.count({ where: { orderItemId: order.items[0].id } }), 2);
    assert.equal(await db.branchAuditLog.count({ where: { entityId: payment.id } }), 1);
  });

  it('aggregates actual PostgreSQL reports in branch timezone without foreign branch revenue', async () => {
    const sale = await makeOrder(branch.id, {
      paymentStatus: 'PAID',
      status: 'COMPLETED',
      paidAt: new Date('2026-09-30T17:30:00Z'),
      placedAt: new Date('2026-09-30T17:30:00Z'),
    });
    await db.orderItemUnit.create({
      data: {
        orderItemId: sale.items[0].id,
        sequence: 1,
        status: 'READY',
        startedAt: new Date('2026-09-30T17:30:00Z'),
        completedAt: new Date('2026-09-30T17:31:00Z'),
      },
    });
    await db.payment.create({
      data: {
        paymentCode: randomUUID(),
        orderId: sale.id,
        method: 'CASH',
        status: 'SUCCESS',
        amount: 100,
        paidAt: sale.paidAt,
      },
    });
    await makeOrder(otherBranch.id, {
      paymentStatus: 'PAID',
      status: 'COMPLETED',
      totalAmount: 99999,
      paidAt: sale.paidAt,
    });
    await makeOrder(branch.id, {
      status: 'CANCELLED',
      cancellationReason: 'Customer changed mind',
      cancelledAt: sale.paidAt,
    });
    const r = await api('/manager/reports?from=2026-10-01&to=2026-10-01', managerToken);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(Number(r.body.summary.revenue), 100);
    assert.equal(r.body.summary.orderCount, 1);
    assert.equal(r.body.revenue[0].bucket, '2026-10-01');
    assert.equal(Number(r.body.payments[0].receivedAmount), 100);
    assert.equal(r.body.topToppings[0].quantity, 2);
    assert.equal(r.body.topItems[0].name, 'Historic coffee');
    assert.equal(r.body.preparation.averageSeconds, 60);
    assert.equal(r.body.ordersByHour.length, 24);
    assert.equal(r.body.cancellations.total, 1);
    assert.equal(r.body.cancellations.items[0].reason, 'Customer changed mind');
    for (const granularity of ['week', 'month'])
      assert.equal(
        (
          await api(
            `/manager/reports?from=2026-10-01&to=2026-10-01&granularity=${granularity}`,
            managerToken,
          )
        ).status,
        200,
      );
    assert.equal(
      (await api('/manager/reports?from=2026-02-30&to=2026-03-01', managerToken)).status,
      400,
    );
    const empty = await api('/manager/reports?from=2020-01-01&to=2020-01-02', managerToken);
    assert.equal(empty.status, 200);
    assert.equal(empty.body.summary.orderCount, 0);
    assert.equal(empty.body.revenue.length, 2);
    assert.equal(empty.body.preparation.averageSeconds, null);
  });

  it('preserves cashier cash settlement for table sessions and records paidAt for reports', async () => {
    const session = await db.tableSession.create({
      data: {
        sessionCode: randomUUID(),
        branchId: branch.id,
        openedByWaiterId: manager.id,
        guestCount: 1,
      },
    });
    const order = await makeOrder(branch.id, { type: 'DINE_IN', tableSessionId: session.id });
    const pending = await api(`/table-sessions/${session.id}/payments`, cashierToken, 'POST', {
      method: 'CASH',
      amount: 100,
    });
    assert.equal(pending.status, 201);
    const confirmed = await api(`/payments/${pending.body.id}/confirm`, cashierToken, 'POST', {});
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    const updated = await db.order.findUnique({ where: { id: order.id } });
    assert.equal(updated.paymentStatus, 'PAID');
    assert.ok(updated.paidAt);
    assert.equal(await db.orderItemUnit.count({ where: { orderItemId: order.items[0].id } }), 0);
    const search = await api(
      `/manager/orders?orderCode=${order.orderCode}&paymentMethod=CASH`,
      managerToken,
    );
    assert.equal(search.body.total, 1);
    assert.equal(search.body.items[0].tableSession.payments.length, 1);
  });

  it('cancels invoices only in the Manager branch and records reason and actor atomically', async () => {
    const invoice = await db.invoice.create({
      data: {
        invoiceNumber: randomUUID(),
        chainId: chain.id,
        branchId: branch.id,
        subtotal: 100,
        totalAmount: 100,
        paidAmount: 100,
        sellerName: 'Test chain',
        sellerAddress: 'Address',
        issuedById: cashier.id,
      },
    });
    const path = `/invoices/${invoice.id}/cancel`;
    assert.equal((await api(path, otherToken, 'POST', { reason: 'Wrong branch' })).status, 403);
    assert.equal((await api(path, managerToken, 'POST', { reason: '   ' })).status, 400);
    const r = await api(path, managerToken, 'POST', { reason: 'Incorrect invoice details' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.cancelledById, manager.id);
    assert.equal(
      (await api(path, managerToken, 'POST', { reason: 'Duplicate request' })).status,
      409,
    );
    const logs = await db.branchAuditLog.findMany({ where: { entityId: invoice.id } });
    assert.equal(logs.length, 1);
    assert.equal(logs[0].reason, 'Incorrect invoice details');
    assert.equal(logs[0].actorUserId, manager.user.id);
  });

  it('keeps audit logs branch-scoped and rejects writes when subscription is expired', async () => {
    const own = await api(`/manager/audit-logs?entityId=${createdStaff.id}`, managerToken);
    const other = await api(`/manager/audit-logs?entityId=${createdStaff.id}`, otherToken);
    assert.ok(own.body.total > 0);
    assert.equal(other.body.total, 0);
    await db.businessSubscription.update({
      where: { chainId: chain.id },
      data: { expiresAt: new Date('2020-01-01') },
    });
    assert.equal((await api('/manager/staff', managerToken, 'POST', staffData())).status, 403);
    assert.equal(
      (
        await api(`/manager/menu-options/${option.id}/availability`, managerToken, 'PATCH', {
          isAvailable: false,
        })
      ).status,
      403,
    );
    assert.equal((await api('/manager/orders', managerToken)).status, 200);
  });
});
