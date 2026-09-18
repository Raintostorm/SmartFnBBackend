import 'reflect-metadata';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { NestFactory } from '@nestjs/core';
import { argon2id, hash } from 'argon2';
import { AppModule } from '../dist/app.module.js';
import { configureApplication } from '../dist/app.setup.js';
import { PrismaService } from '../dist/database/prisma.service.js';
import { configureSwagger } from '../dist/swagger.setup.js';

describe('Platform onboarding authentication and authorization', () => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const ownerEmail = `owner-${suffix}@example.com`;
  const adminEmail = `admin-${suffix}@example.com`;
  const password = 'StrongPass123';
  let app;
  let prisma;
  let baseUrl;
  let applicationId;
  let businessId;
  let ownerUserId;
  let ownerAuth;
  let adminAuth;

  async function request(path, options = {}) {
    const response = await fetch(`${baseUrl}/api/v1${path}`, {
      ...options,
      headers: { 'content-type': 'application/json', ...options.headers },
    });
    const body = await response.json();
    return { response, body };
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
    await prisma.user.create({ data: { email: adminEmail, passwordHash, roleId: adminRole.id } });
  });

  after(async () => {
    if (prisma) {
      if (businessId) {
        const wallet = await prisma.businessWallet.findUnique({ where: { chainId: businessId } });
        if (wallet) {
          await prisma.walletLedgerEntry.deleteMany({ where: { walletId: wallet.id } });
          await prisma.withdrawalRequest.deleteMany({ where: { walletId: wallet.id } });
        }
      }
      if (applicationId) {
        await prisma.registrationApplication.deleteMany({ where: { id: applicationId } });
      }
      await prisma.user.deleteMany({ where: { email: { in: [ownerEmail, adminEmail] } } });
      if (businessId) {
        await prisma.restaurantChain.deleteMany({ where: { id: businessId } });
      }
      await prisma.emailOutbox.deleteMany({ where: { recipient: ownerEmail } });
    }
    await app?.close();
  });

  it('publishes the revised Platform Admin API in Swagger', async () => {
    const document = await (await fetch(`${baseUrl}/api/docs-json`)).json();
    assert.ok(document.paths['/api/v1/registration-applications'].post);
    assert.ok(document.paths['/api/v1/admin/registration-applications/{id}/approve'].post);
    assert.ok(document.paths['/api/v1/admin/businesses'].get);
    assert.ok(document.paths['/api/v1/admin/withdrawals'].get);
    assert.ok(document.paths['/api/v1/auth/setup-password'].post);
    assert.equal(document.paths['/api/v1/auth/owners'], undefined);
    assert.equal(document.paths['/api/v1/owners/{ownerId}/chains'], undefined);
  });

  it('provisions an inactive Owner only after ADMIN approves an application', async () => {
    const adminLogin = await request('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: adminEmail, password }),
    });
    assert.equal(adminLogin.response.status, 200);
    adminAuth = adminLogin.body;

    const submitted = await request('/registration-applications', {
      method: 'POST',
      body: JSON.stringify({
        businessName: 'Authentication Test Company',
        representativeName: 'Test Owner',
        representativeEmail: ownerEmail,
        representativePhone: `090${Date.now().toString().slice(-7)}`,
      }),
    });
    assert.equal(submitted.response.status, 201);
    applicationId = submitted.body.id;

    const approved = await request(`/admin/registration-applications/${applicationId}/approve`, {
      method: 'POST',
      headers: { authorization: `Bearer ${adminAuth.accessToken}` },
      body: JSON.stringify({ subscriptionMonths: 1 }),
    });
    assert.equal(approved.response.status, 200);
    assert.equal(approved.body.status, 'APPROVED');
    assert.equal(approved.body.ownerUser.status, 'INACTIVE');
    businessId = approved.body.approvedChain.id;
    ownerUserId = approved.body.ownerUser.id;

    const loginBeforeSetup = await request('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: ownerEmail, password }),
    });
    assert.equal(loginBeforeSetup.response.status, 401);

    const outbox = await prisma.emailOutbox.findFirstOrThrow({
      where: { recipient: ownerEmail, template: 'OWNER_ACCOUNT_CREATED' },
      orderBy: { createdAt: 'desc' },
    });
    const setup = await request('/auth/setup-password', {
      method: 'POST',
      body: JSON.stringify({ token: outbox.payload.setupToken, password }),
    });
    assert.equal(setup.response.status, 200);

    const ownerLogin = await request('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: ownerEmail, password }),
    });
    assert.equal(ownerLogin.response.status, 200);
    assert.equal(ownerLogin.body.user.role, 'OWNER');
    ownerAuth = ownerLogin.body;
  });

  it('separates Platform Admin access from restaurant operations', async () => {
    const adminBranches = await request('/branches', {
      headers: { authorization: `Bearer ${adminAuth.accessToken}` },
    });
    assert.equal(adminBranches.response.status, 403);

    const ownerBusinesses = await request('/admin/businesses', {
      headers: { authorization: `Bearer ${ownerAuth.accessToken}` },
    });
    assert.equal(ownerBusinesses.response.status, 403);

    const ownerStatusChange = await request(`/users/${ownerUserId}/status`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${ownerAuth.accessToken}` },
      body: JSON.stringify({ status: 'SUSPENDED' }),
    });
    assert.equal(ownerStatusChange.response.status, 403);
  });

  it('processes Owner withdrawals without exposing direct wallet mutation APIs', async () => {
    await prisma.businessWallet.update({
      where: { chainId: businessId },
      data: { balance: 500000 },
    });

    const requested = await request('/owner/withdrawals', {
      method: 'POST',
      headers: { authorization: `Bearer ${ownerAuth.accessToken}` },
      body: JSON.stringify({
        businessId,
        amount: 200000,
        bankName: 'Vietcombank',
        bankAccountName: 'TEST OWNER',
        bankAccountNumber: '0123456789',
      }),
    });
    assert.equal(requested.response.status, 201);
    assert.equal(requested.body.status, 'PENDING');

    const approved = await request(`/admin/withdrawals/${requested.body.id}/approve`, {
      method: 'POST',
      headers: { authorization: `Bearer ${adminAuth.accessToken}` },
    });
    assert.equal(approved.response.status, 200);
    assert.equal(approved.body.status, 'APPROVED');

    const transferred = await request(`/admin/withdrawals/${requested.body.id}/confirm-transfer`, {
      method: 'POST',
      headers: { authorization: `Bearer ${adminAuth.accessToken}` },
      body: JSON.stringify({ bankTransactionCode: `BANK-${suffix}`.slice(0, 100) }),
    });
    assert.equal(transferred.response.status, 200);
    assert.equal(transferred.body.status, 'TRANSFERRED');

    const wallet = await request(`/admin/businesses/${businessId}/wallet`, {
      headers: { authorization: `Bearer ${adminAuth.accessToken}` },
    });
    assert.equal(wallet.response.status, 200);
    assert.equal(Number(wallet.body.balance), 300000);
    assert.equal(Number(wallet.body.heldBalance), 0);
    assert.equal(wallet.body.ledger.items[0].type, 'WITHDRAWAL');
    assert.equal(Number(wallet.body.ledger.items[0].amount), -200000);
  });

  it('lets ADMIN suspend and reactivate an Owner account', async () => {
    const suspended = await request(`/users/${ownerUserId}/status`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${adminAuth.accessToken}` },
      body: JSON.stringify({ status: 'SUSPENDED' }),
    });
    assert.equal(suspended.response.status, 200);

    const revokedProfile = await request('/auth/me', {
      headers: { authorization: `Bearer ${ownerAuth.accessToken}` },
    });
    assert.equal(revokedProfile.response.status, 401);

    const reactivated = await request(`/users/${ownerUserId}/status`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${adminAuth.accessToken}` },
      body: JSON.stringify({ status: 'ACTIVE' }),
    });
    assert.equal(reactivated.response.status, 200);
  });
});
