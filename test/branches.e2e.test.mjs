import 'reflect-metadata';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { NestFactory } from '@nestjs/core';
import { argon2id, hash } from 'argon2';
import { AppModule } from '../dist/app.module.js';
import { configureApplication } from '../dist/app.setup.js';
import { PrismaService } from '../dist/database/prisma.service.js';
import { configureSwagger } from '../dist/swagger.setup.js';

describe('Restaurant chain management and role scopes', () => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const password = 'StrongPass123';
  const emails = {
    admin: `chain-admin-${suffix}@example.com`,
    owner: `chain-owner-${suffix}@example.com`,
    manager: `chain-manager-${suffix}@example.com`,
    unownedManager: `unowned-manager-${suffix}@example.com`,
    waiter: `chain-waiter-${suffix}@example.com`,
    kitchen: `chain-kitchen-${suffix}@example.com`,
    cashier: `chain-cashier-${suffix}@example.com`,
  };
  let app;
  let prisma;
  let baseUrl;
  let adminAuth;
  let ownerAuth;
  let managerAuth;
  let waiterAuth;
  let kitchenAuth;
  let cashierAuth;
  let chainId;
  let unownedChainId;
  let branchId;
  let secondBranchId;
  let unownedBranchId;
  let diningAreaId;
  let kitchenAreaId;
  let ownerProfileId;

  async function request(path, options = {}) {
    const response = await fetch(`${baseUrl}/api/v1${path}`, {
      ...options,
      headers: {
        'content-type': 'application/json',
        ...options.headers,
      },
    });
    const body = await response.json();
    return { response, body };
  }

  async function login(email) {
    const result = await request('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    assert.equal(result.response.status, 200);
    return result.body;
  }

  async function createStaff(role, email, branch, code) {
    const result = await request('/auth/staff', {
      method: 'POST',
      headers: { authorization: `Bearer ${adminAuth.accessToken}` },
      body: JSON.stringify({
        email,
        password,
        role,
        branchId: branch,
        employeeCode: code,
        firstName: 'Role',
        lastName: role,
      }),
    });
    assert.equal(result.response.status, 201);
    return result.body;
  }

  before(async () => {
    app = await NestFactory.create(AppModule, { logger: false });
    configureApplication(app);
    configureSwagger(app);
    await app.listen(0, '127.0.0.1');

    const address = app.getHttpServer().address();
    baseUrl = `http://127.0.0.1:${address.port}`;
    prisma = app.get(PrismaService);

    const adminRole = await prisma.role.findUniqueOrThrow({ where: { code: 'ADMIN' } });
    const passwordHash = await hash(password, {
      type: argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });
    await prisma.user.create({
      data: { email: emails.admin, passwordHash, roleId: adminRole.id },
    });
    adminAuth = await login(emails.admin);
  });

  after(async () => {
    if (prisma) {
      await prisma.user.deleteMany({ where: { email: { in: Object.values(emails) } } });
      if (chainId) {
        await prisma.branch.deleteMany({ where: { chainId } });
        await prisma.restaurantChain.deleteMany({ where: { id: chainId } });
      }
      if (unownedChainId) {
        await prisma.branch.deleteMany({ where: { chainId: unownedChainId } });
        await prisma.restaurantChain.deleteMany({ where: { id: unownedChainId } });
      }
    }
    await app?.close();
  });

  it('lets ADMIN create a chain, branches, hours, and areas', async () => {
    const chain = await request('/restaurant-chains', {
      method: 'POST',
      headers: { authorization: `Bearer ${adminAuth.accessToken}` },
      body: JSON.stringify({
        code: `CHAIN_${suffix}`.slice(0, 50),
        name: 'Role Test Restaurant Chain',
      }),
    });
    assert.equal(chain.response.status, 201);
    chainId = chain.body.id;

    const createBranch = async (code, name) =>
      request(`/restaurant-chains/${chainId}/branches`, {
        method: 'POST',
        headers: { authorization: `Bearer ${adminAuth.accessToken}` },
        body: JSON.stringify({
          code,
          name,
          addressLine1: '1 Test Street',
          city: 'Ho Chi Minh City',
        }),
      });

    const first = await createBranch(`B1-${suffix}`.slice(0, 50), 'First Branch');
    const second = await createBranch(`B2-${suffix}`.slice(0, 50), 'Second Branch');
    assert.equal(first.response.status, 201);
    assert.equal(second.response.status, 201);
    branchId = first.body.id;
    secondBranchId = second.body.id;

    const unownedChain = await request('/restaurant-chains', {
      method: 'POST',
      headers: { authorization: `Bearer ${adminAuth.accessToken}` },
      body: JSON.stringify({
        code: `OTHER_${suffix}`.slice(0, 50),
        name: 'Unowned Restaurant Chain',
      }),
    });
    assert.equal(unownedChain.response.status, 201);
    unownedChainId = unownedChain.body.id;
    const unownedBranch = await request(`/restaurant-chains/${unownedChainId}/branches`, {
      method: 'POST',
      headers: { authorization: `Bearer ${adminAuth.accessToken}` },
      body: JSON.stringify({
        code: `OTHER-B-${suffix}`.slice(0, 50),
        name: 'Unowned Branch',
        addressLine1: '2 Test Street',
        city: 'Ho Chi Minh City',
      }),
    });
    assert.equal(unownedBranch.response.status, 201);
    unownedBranchId = unownedBranch.body.id;

    const weeklyHours = await request(`/branches/${branchId}/operating-hours/1`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${adminAuth.accessToken}` },
      body: JSON.stringify({ openTime: '08:00', closeTime: '22:00', isClosed: false }),
    });
    assert.equal(weeklyHours.response.status, 200);
    assert.equal(weeklyHours.body.dayOfWeek, 1);

    const createArea = async (code, name, type) =>
      request(`/branches/${branchId}/areas`, {
        method: 'POST',
        headers: { authorization: `Bearer ${adminAuth.accessToken}` },
        body: JSON.stringify({ code, name, type, floor: 1 }),
      });

    const dining = await createArea('DINING-01', 'Dining Room', 'DINING');
    const kitchen = await createArea('KITCHEN-01', 'Main Kitchen', 'KITCHEN');
    const bar = await createArea('BAR-01', 'Drink Bar', 'BAR');
    const cashier = await createArea('CASHIER-01', 'Cashier Desk', 'CASHIER');
    assert.deepEqual(
      [dining, kitchen, bar, cashier].map((result) => result.response.status),
      [201, 201, 201, 201],
    );
    diningAreaId = dining.body.id;
    kitchenAreaId = kitchen.body.id;

    const document = await (await fetch(`${baseUrl}/api/docs-json`)).json();
    assert.ok(document.paths['/api/v1/restaurant-chains'].post);
    assert.ok(document.paths['/api/v1/branches/{branchId}/areas'].get);
    assert.ok(document.paths['/api/v1/owners/{ownerId}/chains'].put);
    assert.equal(document.paths['/api/v1/managers/{managerId}/branches'], undefined);
    assert.ok(document.paths['/api/v1/public/branches'].get);
  });

  it('lets ADMIN create an OWNER and assign its restaurant chain', async () => {
    const owner = await request('/auth/owners', {
      method: 'POST',
      headers: { authorization: `Bearer ${adminAuth.accessToken}` },
      body: JSON.stringify({
        email: emails.owner,
        password,
        firstName: 'Chain',
        lastName: 'Owner',
      }),
    });
    assert.equal(owner.response.status, 201);
    assert.equal(owner.body.user.role, 'OWNER');
    ownerProfileId = owner.body.user.owner.id;

    const assignment = await request(`/owners/${ownerProfileId}/chains`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${adminAuth.accessToken}` },
      body: JSON.stringify({ chainIds: [chainId] }),
    });
    assert.equal(assignment.response.status, 200);
    assert.deepEqual(
      assignment.body.chains.map((chain) => chain.id),
      [chainId],
    );
    ownerAuth = await login(emails.owner);
  });

  it('lets OWNER create a MANAGER for one branch and ADMIN create other staff', async () => {
    const forbiddenManager = await request('/auth/managers', {
      method: 'POST',
      headers: { authorization: `Bearer ${ownerAuth.accessToken}` },
      body: JSON.stringify({
        email: emails.unownedManager,
        password,
        branchId: unownedBranchId,
        employeeCode: `UM-${suffix}`.slice(0, 50),
        firstName: 'Unowned',
        lastName: 'Manager',
      }),
    });
    assert.equal(forbiddenManager.response.status, 403);

    const manager = await request('/auth/managers', {
      method: 'POST',
      headers: { authorization: `Bearer ${ownerAuth.accessToken}` },
      body: JSON.stringify({
        email: emails.manager,
        password,
        branchId,
        employeeCode: `M-${suffix}`.slice(0, 50),
        firstName: 'Role',
        lastName: 'Manager',
      }),
    });
    assert.equal(manager.response.status, 201);
    assert.equal(manager.body.user.role, 'MANAGER');
    assert.equal(manager.body.user.employee.branchId, branchId);

    await createStaff('WAITER', emails.waiter, branchId, `W-${suffix}`.slice(0, 50));
    await createStaff('KITCHEN', emails.kitchen, branchId, `K-${suffix}`.slice(0, 50));
    await createStaff('CASHIER', emails.cashier, branchId, `C-${suffix}`.slice(0, 50));

    managerAuth = await login(emails.manager);
    waiterAuth = await login(emails.waiter);
    kitchenAuth = await login(emails.kitchen);
    cashierAuth = await login(emails.cashier);
  });

  it('lets OWNER manage all owned-chain branches while MANAGER stays on one branch', async () => {
    const ownerBranches = await request('/branches', {
      headers: { authorization: `Bearer ${ownerAuth.accessToken}` },
    });
    assert.equal(ownerBranches.response.status, 200);
    assert.deepEqual(
      ownerBranches.body.map((branch) => branch.id).sort(),
      [branchId, secondBranchId].sort(),
    );

    const ownerUpdated = await request(`/branches/${secondBranchId}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${ownerAuth.accessToken}` },
      body: JSON.stringify({ name: 'Second Branch Owned' }),
    });
    assert.equal(ownerUpdated.response.status, 200);

    const managerCannotAccessSecond = await request(`/branches/${secondBranchId}`, {
      headers: { authorization: `Bearer ${managerAuth.accessToken}` },
    });
    assert.equal(managerCannotAccessSecond.response.status, 403);

    const managerBranches = await request('/branches', {
      headers: { authorization: `Bearer ${managerAuth.accessToken}` },
    });
    assert.equal(managerBranches.response.status, 200);
    assert.deepEqual(managerBranches.body.map((branch) => branch.id).sort(), [branchId]);

    const updated = await request(`/branches/${branchId}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${managerAuth.accessToken}` },
      body: JSON.stringify({ name: 'Second Branch Managed' }),
    });
    assert.equal(updated.response.status, 200);

    const cannotDeactivate = await request(`/branches/${branchId}/status`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${managerAuth.accessToken}` },
      body: JSON.stringify({ status: 'INACTIVE' }),
    });
    assert.equal(cannotDeactivate.response.status, 403);

    const cannotManageChain = await request(`/restaurant-chains/${chainId}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${managerAuth.accessToken}` },
      body: JSON.stringify({ name: 'Forbidden update' }),
    });
    assert.equal(cannotManageChain.response.status, 403);
  });

  it('enforces branch scope and area visibility for each staff role', async () => {
    const waiterBranches = await request('/branches', {
      headers: { authorization: `Bearer ${waiterAuth.accessToken}` },
    });
    assert.equal(waiterBranches.response.status, 200);
    assert.deepEqual(
      waiterBranches.body.map((branch) => branch.id),
      [branchId],
    );

    const otherBranch = await request(`/branches/${secondBranchId}`, {
      headers: { authorization: `Bearer ${waiterAuth.accessToken}` },
    });
    assert.equal(otherBranch.response.status, 403);

    const waiterAreas = await request(`/branches/${branchId}/areas`, {
      headers: { authorization: `Bearer ${waiterAuth.accessToken}` },
    });
    assert.deepEqual([...new Set(waiterAreas.body.map((area) => area.type))], ['DINING']);

    const kitchenAreas = await request(`/branches/${branchId}/areas`, {
      headers: { authorization: `Bearer ${kitchenAuth.accessToken}` },
    });
    assert.deepEqual([...new Set(kitchenAreas.body.map((area) => area.type))].sort(), [
      'BAR',
      'KITCHEN',
    ]);

    const cashierAreas = await request(`/branches/${branchId}/areas`, {
      headers: { authorization: `Bearer ${cashierAuth.accessToken}` },
    });
    assert.deepEqual([...new Set(cashierAreas.body.map((area) => area.type))], ['CASHIER']);
  });

  it('lets KITCHEN change kitchen/bar status but not dining status', async () => {
    const allowed = await request(`/branches/${branchId}/areas/${kitchenAreaId}/status`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${kitchenAuth.accessToken}` },
      body: JSON.stringify({ status: 'INACTIVE' }),
    });
    assert.equal(allowed.response.status, 200);

    const forbiddenType = await request(`/branches/${branchId}/areas/${diningAreaId}/status`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${kitchenAuth.accessToken}` },
      body: JSON.stringify({ status: 'INACTIVE' }),
    });
    assert.equal(forbiddenType.response.status, 403);

    const waiterMutation = await request(`/branches/${branchId}/areas/${diningAreaId}/status`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${waiterAuth.accessToken}` },
      body: JSON.stringify({ status: 'INACTIVE' }),
    });
    assert.equal(waiterMutation.response.status, 403);
  });

  it('exposes active public data without requiring a customer account', async () => {
    const publicBranch = await request(`/public/branches/${branchId}`);
    assert.equal(publicBranch.response.status, 200);
    assert.ok(publicBranch.body.areas.every((area) => ['DINING', 'PICKUP'].includes(area.type)));

    const deactivated = await request(`/branches/${branchId}/status`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${adminAuth.accessToken}` },
      body: JSON.stringify({ status: 'INACTIVE' }),
    });
    assert.equal(deactivated.response.status, 200);

    const hidden = await request(`/public/branches/${branchId}`);
    assert.equal(hidden.response.status, 404);
  });
});
