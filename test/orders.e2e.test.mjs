import 'reflect-metadata';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { NestFactory } from '@nestjs/core';
import { argon2id, hash } from 'argon2';
import { AppModule } from '../dist/app.module.js';
import { configureApplication } from '../dist/app.setup.js';
import { configureSwagger } from '../dist/swagger.setup.js';
import { PrismaService } from '../dist/database/prisma.service.js';

describe('Waiter and Kitchen Staff operational flow', () => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const password = 'StrongPass123';
  const emails = {
    waiter: `flow-waiter-${suffix}@example.com`,
    kitchen: `flow-kitchen-${suffix}@example.com`,
  };
  let app, prisma, baseUrl, waiterToken, kitchenToken, branchId, chainId, orderId, itemId, taskId;

  async function api(path, token, options = {}) {
    const response = await fetch(`${baseUrl}/api/v1${path}`, {
      ...options,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        ...options.headers,
      },
    });
    const body = await response.json();
    return { response, body };
  }
  async function login(email) {
    const result = await api('/auth/login', '', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    assert.equal(result.response.status, 200);
    return result.body.accessToken;
  }

  before(async () => {
    app = await NestFactory.create(AppModule, { logger: false });
    configureApplication(app);
    configureSwagger(app);
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${app.getHttpServer().address().port}`;
    prisma = app.get(PrismaService);
    const passwordHash = await hash(password, {
      type: argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });
    const chain = await prisma.restaurantChain.create({
      data: { code: `FLOW-${suffix}`.slice(0, 50), name: 'Flow Test Chain' },
    });
    chainId = chain.id;
    const branch = await prisma.branch.create({
      data: {
        chainId,
        code: `FB-${suffix}`.slice(0, 50),
        name: 'Flow Branch',
        addressLine1: 'Test',
        city: 'HCMC',
      },
    });
    branchId = branch.id;
    const roles = await prisma.role.findMany({ where: { code: { in: ['WAITER', 'KITCHEN'] } } });
    const role = Object.fromEntries(roles.map((r) => [r.code, r.id]));
    const waiterUser = await prisma.user.create({
      data: { email: emails.waiter, passwordHash, roleId: role.WAITER },
    });
    const kitchenUser = await prisma.user.create({
      data: { email: emails.kitchen, passwordHash, roleId: role.KITCHEN },
    });
    const waiter = await prisma.employee.create({
      data: {
        userId: waiterUser.id,
        branchId,
        employeeCode: `W-${suffix}`.slice(0, 50),
        firstName: 'Flow',
        lastName: 'Waiter',
      },
    });
    await prisma.employee.create({
      data: {
        userId: kitchenUser.id,
        branchId,
        employeeCode: `K-${suffix}`.slice(0, 50),
        firstName: 'Flow',
        lastName: 'Kitchen',
      },
    });
    const table = await prisma.restaurantTable.create({
      data: { branchId, code: 'T-FLOW', capacity: 4, status: 'OCCUPIED' },
    });
    const session = await prisma.tableSession.create({
      data: {
        sessionCode: `TS-${suffix}`.slice(0, 50),
        branchId,
        openedByWaiterId: waiter.id,
        guestCount: 2,
        status: 'SERVING',
        tables: { create: { tableId: table.id } },
      },
    });
    const category = await prisma.menuCategory.create({
      data: { chainId, name: `Flow Menu ${suffix}` },
    });
    const menuItem = await prisma.menuItem.create({
      data: {
        categoryId: category.id,
        sku: `SKU-${suffix}`.slice(0, 50),
        name: 'Test Dish',
        price: 50000,
      },
    });
    await prisma.branchMenuItem.create({
      data: { branchId, menuItemId: menuItem.id, remainingPortions: 10 },
    });
    waiterToken = await login(emails.waiter);
    kitchenToken = await login(emails.kitchen);
    const order = await api('/waiter/orders', waiterToken, {
      method: 'POST',
      body: JSON.stringify({ tableSessionId: session.id }),
    });
    assert.equal(order.response.status, 201);
    orderId = order.body.id;
    const item = await api(`/waiter/orders/${orderId}/items`, waiterToken, {
      method: 'POST',
      body: JSON.stringify({
        menuItemId: menuItem.id,
        quantity: 2,
        specialInstructions: 'No onion',
      }),
    });
    assert.equal(item.response.status, 201);
    itemId = item.body.id;
  });

  it('publishes a complete and consistent OpenAPI contract for waiter and kitchen flows', async () => {
    const response = await fetch(`${baseUrl}/api/docs-json`);
    assert.equal(response.status, 200);
    const document = await response.json();
    const operations = [
      ['/api/v1/waiter/orders/context/current', 'get', 'Waiter · Orders'],
      ['/api/v1/waiter/orders', 'post', 'Waiter · Orders'],
      ['/api/v1/waiter/orders/{orderId}', 'get', 'Waiter · Orders'],
      ['/api/v1/waiter/orders/{orderId}/items', 'post', 'Waiter · Orders'],
      ['/api/v1/waiter/orders/{orderId}/submit', 'post', 'Waiter · Orders'],
      ['/api/v1/kitchen/queue', 'get', 'Kitchen · Queue'],
      ['/api/v1/kitchen/items/{itemId}/start', 'post', 'Kitchen · Queue'],
      ['/api/v1/kitchen/items/{itemId}/ready', 'post', 'Kitchen · Queue'],
      ['/api/v1/kitchen/items/{itemId}/unavailable', 'post', 'Kitchen · Queue'],
      ['/api/v1/waiter/serving-tasks', 'get', 'Waiter · Serving'],
      ['/api/v1/waiter/serving-tasks/{taskId}/claim', 'post', 'Waiter · Serving'],
      ['/api/v1/waiter/serving-tasks/{taskId}/serve', 'post', 'Waiter · Serving'],
    ];

    for (const [path, method, tag] of operations) {
      const operation = document.paths[path]?.[method];
      assert.ok(operation, `Missing OpenAPI operation: ${method.toUpperCase()} ${path}`);
      assert.equal(operation.tags[0], tag);
      assert.ok(operation.summary);
      assert.ok(operation.description);
      assert.ok(operation.responses['401']);
      assert.ok(operation.responses['403']);
    }

    for (const schema of [
      'OrderResponseDto',
      'OrderItemResponseDto',
      'KitchenQueueItemResponseDto',
      'ServingTaskResponseDto',
      'WaiterContextResponseDto',
      'ApiErrorDto',
      'PageMetaDto',
    ]) {
      assert.ok(document.components.schemas[schema], `Missing OpenAPI schema: ${schema}`);
    }
    assert.ok(document.components.securitySchemes['access-token']);
  });

  after(async () => {
    if (prisma && branchId) {
      await prisma.servingTask.deleteMany({ where: { branchId } });
      await prisma.order.deleteMany({ where: { branchId } });
      await prisma.tableSession.deleteMany({ where: { branchId } });
      await prisma.restaurantTable.deleteMany({ where: { branchId } });
      await prisma.branchMenuItem.deleteMany({ where: { branchId } });
      await prisma.menuItem.deleteMany({ where: { category: { chainId } } });
      await prisma.menuCategory.deleteMany({ where: { chainId } });
      await prisma.user.deleteMany({ where: { email: { in: Object.values(emails) } } });
      await prisma.branch.delete({ where: { id: branchId } });
      await prisma.restaurantChain.delete({ where: { id: chainId } });
    }
    await app?.close();
  });

  it('submits the order and exposes it in the kitchen queue', async () => {
    const context = await api('/waiter/orders/context/current', waiterToken);
    assert.equal(context.response.status, 200);
    assert.ok(context.body.tables.length > 0);
    assert.ok(context.body.menuItems.length > 0);
    assert.ok(context.body.orders.some((order) => order.id === orderId));
    const submitted = await api(`/waiter/orders/${orderId}/submit`, waiterToken, {
      method: 'POST',
    });
    assert.equal(submitted.response.status, 201);
    assert.equal(submitted.body.status, 'SUBMITTED');
    const queue = await api('/kitchen/queue', kitchenToken);
    assert.equal(queue.response.status, 200);
    assert.ok(queue.body.data.some((item) => item.id === itemId));
  });
  it('lets kitchen prepare the item and publishes exactly one serving task', async () => {
    const started = await api(`/kitchen/items/${itemId}/start`, kitchenToken, { method: 'POST' });
    assert.equal(started.response.status, 201);
    assert.equal(started.body.status, 'PREPARING');
    const duplicate = await api(`/kitchen/items/${itemId}/start`, kitchenToken, { method: 'POST' });
    assert.equal(duplicate.response.status, 409);
    const ready = await api(`/kitchen/items/${itemId}/ready`, kitchenToken, { method: 'POST' });
    assert.equal(ready.response.status, 201);
    assert.equal(ready.body.status, 'READY');
    taskId = ready.body.servingTask.id;
    assert.equal(await prisma.servingTask.count({ where: { orderItemId: itemId } }), 1);
  });
  it('lets waiter claim and serve the ready item', async () => {
    const claimed = await api(`/waiter/serving-tasks/${taskId}/claim`, waiterToken, {
      method: 'POST',
    });
    assert.equal(claimed.response.status, 201);
    assert.equal(claimed.body.status, 'CLAIMED');
    const served = await api(`/waiter/serving-tasks/${taskId}/serve`, waiterToken, {
      method: 'POST',
    });
    assert.equal(served.response.status, 201);
    assert.equal(served.body.orderItem.status, 'SERVED');
    const order = await api(`/waiter/orders/${orderId}`, waiterToken);
    assert.equal(order.body.status, 'SERVED');
  });
});
