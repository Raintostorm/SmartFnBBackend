import 'reflect-metadata';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { NestFactory } from '@nestjs/core';
import { argon2id, hash } from 'argon2';
import { AppModule } from '../dist/app.module.js';
import { configureApplication } from '../dist/app.setup.js';
import { PrismaService } from '../dist/database/prisma.service.js';
import { configureSwagger } from '../dist/swagger.setup.js';

describe('Owner branch management and role scopes', () => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const password = 'StrongPass123';
  const emails = {
    admin: `branch-admin-${suffix}@example.com`,
    owner: `branch-owner-${suffix}@example.com`,
    manager: `branch-manager-${suffix}@example.com`,
    waiter: `branch-waiter-${suffix}@example.com`,
  };
  let app;
  let prisma;
  let baseUrl;
  let adminAuth;
  let ownerAuth;
  let managerAuth;
  let waiterAuth;
  let applicationId;
  let planId;
  let chainId;
  let firstBranchId;
  let secondBranchId;
  let diningAreaId;

  async function request(path, options = {}) {
    const response = await fetch(`${baseUrl}/api/v1${path}`, {
      ...options,
      headers: { 'content-type': 'application/json', ...options.headers },
    });
    const contentType = response.headers.get('content-type') ?? '';
    const body = contentType.includes('application/json')
      ? await response.json()
      : await response.text();
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

  before(async () => {
    app = await NestFactory.create(AppModule, { logger: false });
    configureApplication(app);
    configureSwagger(app);
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${app.getHttpServer().address().port}`;
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
      if (applicationId) {
        await prisma.registrationApplication.deleteMany({ where: { id: applicationId } });
      }
      await prisma.user.deleteMany({ where: { email: { in: Object.values(emails) } } });
      if (chainId) {
        await prisma.branch.deleteMany({ where: { chainId } });
        await prisma.restaurantChain.deleteMany({ where: { id: chainId } });
      }
      if (planId) {
        await prisma.servicePlan.deleteMany({ where: { id: planId } });
      }
      await prisma.emailOutbox.deleteMany({ where: { recipient: emails.owner } });
    }
    await app?.close();
  });

  it('onboards an Owner with a plan instead of letting ADMIN create a chain', async () => {
    const plan = await request('/admin/service-plans', {
      method: 'POST',
      headers: { authorization: `Bearer ${adminAuth.accessToken}` },
      body: JSON.stringify({
        code: `TEST_${Date.now()}`,
        name: 'Branch E2E Plan',
        monthlyPrice: 100000,
        maxBranches: 2,
        maxAccounts: 5,
        maxTables: 20,
      }),
    });
    assert.equal(plan.response.status, 201);
    planId = plan.body.id;

    const removedAdminChainRoute = await request('/restaurant-chains', {
      method: 'POST',
      headers: { authorization: `Bearer ${adminAuth.accessToken}` },
      body: JSON.stringify({ code: `NO_${suffix}`, name: 'Must Not Be Created' }),
    });
    assert.equal(removedAdminChainRoute.response.status, 404);

    const application = await request('/registration-applications', {
      method: 'POST',
      body: JSON.stringify({
        businessName: 'Owner Branch Test Company',
        representativeName: 'Branch Owner',
        representativeEmail: emails.owner,
        representativePhone: `091${Date.now().toString().slice(-7)}`,
        requestedPlanId: planId,
      }),
    });
    assert.equal(application.response.status, 201);
    applicationId = application.body.id;

    const approved = await request(`/admin/registration-applications/${applicationId}/approve`, {
      method: 'POST',
      headers: { authorization: `Bearer ${adminAuth.accessToken}` },
      body: JSON.stringify({ subscriptionMonths: 2 }),
    });
    assert.equal(approved.response.status, 200);
    chainId = approved.body.approvedChain.id;

    const outbox = await prisma.emailOutbox.findFirstOrThrow({
      where: { recipient: emails.owner, template: 'OWNER_ACCOUNT_CREATED' },
      orderBy: { createdAt: 'desc' },
    });
    const setup = await request('/auth/setup-password', {
      method: 'POST',
      body: JSON.stringify({ token: outbox.payload.setupToken, password }),
    });
    assert.equal(setup.response.status, 200);
    ownerAuth = await login(emails.owner);

    const adminBranches = await request('/branches', {
      headers: { authorization: `Bearer ${adminAuth.accessToken}` },
    });
    assert.equal(adminBranches.response.status, 403);
  });

  it('lets OWNER create branches up to the service-plan limit', async () => {
    const createBranch = (code, name) =>
      request(`/restaurant-chains/${chainId}/branches`, {
        method: 'POST',
        headers: { authorization: `Bearer ${ownerAuth.accessToken}` },
        body: JSON.stringify({
          code,
          name,
          addressLine1: '1 Test Street',
          city: 'Ho Chi Minh City',
        }),
      });

    const first = await createBranch(`B1-${suffix}`.slice(0, 50), 'First Branch');
    const second = await createBranch(`B2-${suffix}`.slice(0, 50), 'Second Branch');
    const overLimit = await createBranch(`B3-${suffix}`.slice(0, 50), 'Third Branch');
    assert.equal(first.response.status, 201);
    assert.equal(second.response.status, 201);
    assert.equal(overLimit.response.status, 409);
    firstBranchId = first.body.id;
    secondBranchId = second.body.id;

    const hours = await request(`/branches/${firstBranchId}/operating-hours/1`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${ownerAuth.accessToken}` },
      body: JSON.stringify({ openTime: '08:00', closeTime: '22:00', isClosed: false }),
    });
    assert.equal(hours.response.status, 200);

    const area = await request(`/branches/${firstBranchId}/areas`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ownerAuth.accessToken}` },
      body: JSON.stringify({ code: 'DINING-01', name: 'Dining Room', type: 'DINING', floor: 1 }),
    });
    assert.equal(area.response.status, 201);
    diningAreaId = area.body.id;
  });

  it('lets OWNER create staff while denying Platform ADMIN', async () => {
    const manager = await request('/auth/managers', {
      method: 'POST',
      headers: { authorization: `Bearer ${ownerAuth.accessToken}` },
      body: JSON.stringify({
        email: emails.manager,
        password,
        branchId: firstBranchId,
        employeeCode: `M-${suffix}`.slice(0, 50),
        firstName: 'Role',
        lastName: 'Manager',
      }),
    });
    assert.equal(manager.response.status, 201);

    const waiterPayload = {
      email: emails.waiter,
      password,
      role: 'WAITER',
      branchId: firstBranchId,
      employeeCode: `W-${suffix}`.slice(0, 50),
      firstName: 'Role',
      lastName: 'Waiter',
    };
    const adminDenied = await request('/auth/staff', {
      method: 'POST',
      headers: { authorization: `Bearer ${adminAuth.accessToken}` },
      body: JSON.stringify(waiterPayload),
    });
    assert.equal(adminDenied.response.status, 403);

    const waiter = await request('/auth/staff', {
      method: 'POST',
      headers: { authorization: `Bearer ${ownerAuth.accessToken}` },
      body: JSON.stringify(waiterPayload),
    });
    assert.equal(waiter.response.status, 201);
    managerAuth = await login(emails.manager);
    waiterAuth = await login(emails.waiter);
  });

  it('keeps MANAGER and WAITER within their one assigned branch', async () => {
    const ownerBranches = await request('/branches', {
      headers: { authorization: `Bearer ${ownerAuth.accessToken}` },
    });
    assert.deepEqual(
      ownerBranches.body.map(({ id }) => id).sort(),
      [firstBranchId, secondBranchId].sort(),
    );

    const managerSecondBranch = await request(`/branches/${secondBranchId}`, {
      headers: { authorization: `Bearer ${managerAuth.accessToken}` },
    });
    assert.equal(managerSecondBranch.response.status, 403);

    const waiterAreas = await request(`/branches/${firstBranchId}/areas`, {
      headers: { authorization: `Bearer ${waiterAuth.accessToken}` },
    });
    assert.equal(waiterAreas.response.status, 200);
    assert.deepEqual(
      waiterAreas.body.map(({ id }) => id),
      [diningAreaId],
    );

    const waiterMutation = await request(
      `/branches/${firstBranchId}/areas/${diningAreaId}/status`,
      {
        method: 'PATCH',
        headers: { authorization: `Bearer ${waiterAuth.accessToken}` },
        body: JSON.stringify({ status: 'INACTIVE' }),
      },
    );
    assert.equal(waiterMutation.response.status, 403);
  });
});
