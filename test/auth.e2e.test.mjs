import 'reflect-metadata';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { NestFactory } from '@nestjs/core';
import { argon2id, hash } from 'argon2';
import { AppModule } from '../dist/app.module.js';
import { configureApplication } from '../dist/app.setup.js';
import { PrismaService } from '../dist/database/prisma.service.js';
import { configureSwagger } from '../dist/swagger.setup.js';

describe('Authentication and authorization', () => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const customerEmail = `customer-${suffix}@example.com`;
  const adminEmail = `admin-${suffix}@example.com`;
  const waiterEmail = `waiter-${suffix}@example.com`;
  const password = 'StrongPass123';
  let app;
  let prisma;
  let baseUrl;
  let branchId;
  let customerId;
  let customerAuth;
  let adminAuth;

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
      data: {
        email: adminEmail,
        passwordHash,
        roleId: adminRole.id,
      },
    });

    const branch = await prisma.branch.create({
      data: {
        code: `TEST-${suffix}`.slice(0, 50),
        name: 'Authentication Test Branch',
        addressLine1: 'Test address',
        city: 'Ho Chi Minh City',
      },
    });
    branchId = branch.id;
  });

  after(async () => {
    if (prisma) {
      await prisma.user.deleteMany({
        where: { email: { in: [customerEmail, adminEmail, waiterEmail] } },
      });

      if (branchId) {
        await prisma.branch.deleteMany({ where: { id: branchId } });
      }
    }

    await app?.close();
  });

  it('serves Swagger UI metadata and the OpenAPI document', async () => {
    const uiResponse = await fetch(`${baseUrl}/api/docs`);
    const response = await fetch(`${baseUrl}/api/docs-json`);
    const document = await response.json();

    assert.equal(uiResponse.status, 200);
    assert.match(await uiResponse.text(), /id="swagger-ui"/i);
    assert.equal(response.status, 200);
    assert.equal(document.info.title, 'Smart F&B Chain Platform API');
    assert.ok(document.components.securitySchemes['access-token']);
    assert.ok(document.components.schemas.LoginDto.properties.email);
    assert.ok(document.components.schemas.AuthResponseDto.properties.accessToken);
    assert.ok(document.paths['/api/v1/auth/login'].post);
    assert.ok(document.paths['/api/v1/users/{userId}/status'].patch);
  });

  it('registers a customer and exposes the authenticated profile', async () => {
    const registration = await request('/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        email: customerEmail,
        password,
        firstName: 'Test',
        lastName: 'Customer',
      }),
    });

    assert.equal(registration.response.status, 201);
    assert.equal(registration.body.user.role, 'CUSTOMER');
    assert.ok(registration.body.accessToken);
    assert.ok(registration.body.refreshToken);
    customerId = registration.body.user.id;
    customerAuth = registration.body;

    const profile = await request('/auth/me', {
      headers: { authorization: `Bearer ${customerAuth.accessToken}` },
    });

    assert.equal(profile.response.status, 200);
    assert.equal(profile.body.email, customerEmail);
    assert.equal(profile.body.role, 'CUSTOMER');
  });

  it('forbids CUSTOMER from creating a staff account', async () => {
    const result = await request('/auth/staff', {
      method: 'POST',
      headers: { authorization: `Bearer ${customerAuth.accessToken}` },
      body: JSON.stringify({
        email: waiterEmail,
        password,
        role: 'WAITER',
        branchId,
        employeeCode: `W-${suffix}`.slice(0, 50),
        firstName: 'Test',
        lastName: 'Waiter',
      }),
    });

    assert.equal(result.response.status, 403);

    const statusChange = await request(`/users/${customerId}/status`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${customerAuth.accessToken}` },
      body: JSON.stringify({ status: 'SUSPENDED' }),
    });
    assert.equal(statusChange.response.status, 403);
  });

  it('allows ADMIN to create a WAITER account', async () => {
    const login = await request('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: adminEmail, password }),
    });

    assert.equal(login.response.status, 200);
    assert.equal(login.body.user.role, 'ADMIN');
    adminAuth = login.body;

    const result = await request('/auth/staff', {
      method: 'POST',
      headers: { authorization: `Bearer ${adminAuth.accessToken}` },
      body: JSON.stringify({
        email: waiterEmail,
        password,
        role: 'WAITER',
        branchId,
        employeeCode: `W-${suffix}`.slice(0, 50),
        firstName: 'Test',
        lastName: 'Waiter',
      }),
    });

    assert.equal(result.response.status, 201);
    assert.equal(result.body.user.role, 'WAITER');
    assert.equal(result.body.user.employee.branchId, branchId);
  });

  it('rotates refresh tokens and revokes the session on logout', async () => {
    const refreshed = await request('/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({ refreshToken: customerAuth.refreshToken }),
    });

    assert.equal(refreshed.response.status, 200);
    assert.notEqual(refreshed.body.refreshToken, customerAuth.refreshToken);

    const replay = await request('/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({ refreshToken: customerAuth.refreshToken }),
    });
    assert.equal(replay.response.status, 401);

    const refreshAfterReplay = await request('/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({ refreshToken: refreshed.body.refreshToken }),
    });
    assert.equal(refreshAfterReplay.response.status, 401);

    const logout = await request('/auth/logout', {
      method: 'POST',
      body: JSON.stringify({ refreshToken: refreshed.body.refreshToken }),
    });
    assert.equal(logout.response.status, 200);

    const profile = await request('/auth/me', {
      headers: { authorization: `Bearer ${refreshed.body.accessToken}` },
    });
    assert.equal(profile.response.status, 401);
  });

  it('allows ADMIN to suspend and reactivate another account', async () => {
    const selfChange = await request(`/users/${adminAuth.user.id}/status`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${adminAuth.accessToken}` },
      body: JSON.stringify({ status: 'SUSPENDED' }),
    });
    assert.equal(selfChange.response.status, 400);

    const invalidStatus = await request(`/users/${customerId}/status`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${adminAuth.accessToken}` },
      body: JSON.stringify({ status: 'DELETED' }),
    });
    assert.equal(invalidStatus.response.status, 400);

    const customerLogin = await request('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: customerEmail, password }),
    });
    assert.equal(customerLogin.response.status, 200);

    const suspended = await request(`/users/${customerId}/status`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${adminAuth.accessToken}` },
      body: JSON.stringify({ status: 'SUSPENDED' }),
    });

    assert.equal(suspended.response.status, 200);
    assert.equal(suspended.body.status, 'SUSPENDED');

    const revokedProfile = await request('/auth/me', {
      headers: { authorization: `Bearer ${customerLogin.body.accessToken}` },
    });
    assert.equal(revokedProfile.response.status, 401);

    const suspendedLogin = await request('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: customerEmail, password }),
    });
    assert.equal(suspendedLogin.response.status, 401);

    const reactivated = await request(`/users/${customerId}/status`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${adminAuth.accessToken}` },
      body: JSON.stringify({ status: 'ACTIVE' }),
    });

    assert.equal(reactivated.response.status, 200);
    assert.equal(reactivated.body.status, 'ACTIVE');

    const activeLogin = await request('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: customerEmail, password }),
    });
    assert.equal(activeLogin.response.status, 200);
  });
});
