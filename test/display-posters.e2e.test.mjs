import 'reflect-metadata';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../dist/app.module.js';
import { configureApplication } from '../dist/app.setup.js';
import { configureSwagger } from '../dist/swagger.setup.js';
import { PrismaService } from '../dist/database/prisma.service.js';
import { PasswordService } from '../dist/modules/auth/password.service.js';

if (!/^\/smart_fnb_poster_test_[0-9]+_[a-f0-9]+$/.test(new URL(process.env.DATABASE_URL).pathname))
  throw new Error('Use scripts/test-posters.mjs');
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
  'base64',
);
describe('Owner poster API / real PostgreSQL / paired display', () => {
  let app,
    db,
    base,
    chain,
    otherChain,
    token,
    cashierToken,
    adminToken,
    otherOwnerToken,
    device,
    poster;
  const deviceToken = randomUUID();
  const password = 'PosterTestPass123';
  const path = () => `/restaurant-chains/${chain.id}/display-posters`;
  async function api(route, bearer = token, method = 'GET', body) {
    const response = await fetch(`${base}/api/v1${route}`, {
      method,
      headers: {
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        ...(body instanceof FormData ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined
        ? {}
        : { body: body instanceof FormData ? body : JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  }
  async function upload(bearer = token, bytes = png, type = 'image/png') {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type }), 'poster.png');
    return api(path(), bearer, 'POST', form);
  }
  async function userFor(role, extra = {}) {
    const roleRow = await db.role.upsert({
      where: { code: role },
      create: { code: role, name: role },
      update: {},
    });
    const user = await db.user.create({
      data: {
        email: `${randomUUID()}@example.com`,
        passwordHash: await app.get(PasswordService).hash(password),
        roleId: roleRow.id,
        ...extra,
      },
    });
    const login = await api('/auth/login', null, 'POST', { email: user.email, password });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    return { user, token: login.body.accessToken };
  }
  before(async () => {
    app = await NestFactory.create(AppModule, { logger: false });
    configureApplication(app);
    configureSwagger(app);
    app.useStaticAssets(process.env.UPLOAD_DIR, { prefix: '/uploads/' });
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${app.getHttpServer().address().port}`;
    db = app.get(PrismaService);
    const plan = await db.servicePlan.create({
      data: {
        code: randomUUID(),
        name: 'Test',
        monthlyPrice: 1,
        maxBranches: 5,
        maxAccounts: 30,
        maxTables: 20,
      },
    });
    const chainData = () => ({
      code: randomUUID(),
      name: 'Poster tenant',
      subscription: {
        create: {
          planId: plan.id,
          monthlyPrice: 1,
          startsAt: new Date(),
          expiresAt: new Date(Date.now() + 86400000),
        },
      },
    });
    chain = await db.restaurantChain.create({ data: chainData() });
    otherChain = await db.restaurantChain.create({ data: chainData() });
    const ownerData = (chainId) => ({
      owner: {
        create: {
          ownerCode: randomUUID(),
          firstName: 'Poster',
          lastName: 'Owner',
          chainAssignments: { create: { chainId } },
        },
      },
    });
    token = (await userFor('OWNER', ownerData(chain.id))).token;
    otherOwnerToken = (await userFor('OWNER', ownerData(otherChain.id))).token;
    adminToken = (await userFor('ADMIN')).token;
    const branch = await db.branch.create({
      data: {
        chainId: chain.id,
        code: randomUUID(),
        name: 'Display branch',
        addressLine1: 'Test',
        city: 'HCM',
      },
    });
    const staff = await userFor('CASHIER', {
      employee: {
        create: {
          branchId: branch.id,
          employeeCode: randomUUID(),
          firstName: 'Cashier',
          lastName: 'Test',
        },
      },
    });
    cashierToken = staff.token;
    const employee = await db.employee.findUniqueOrThrow({ where: { userId: staff.user.id } });
    const station = await db.posStation.create({
      data: {
        branchId: branch.id,
        name: 'Station',
        cartVersion: 42,
        cartSnapshot: { state: 'CART', items: [], totalAmount: 123 },
      },
    });
    device = await db.displayDevice.create({
      data: {
        type: 'CUSTOMER_DISPLAY',
        branchId: branch.id,
        stationId: station.id,
        pairedById: employee.id,
        tokenHash: createHash('sha256').update(deviceToken).digest('hex'),
        tokenExpiresAt: new Date(Date.now() + 86400000),
      },
    });
  });
  after(async () => {
    await app?.close();
  });

  it('requires Owner, rejects other roles and foreign tenants', async () => {
    assert.equal((await api(path(), null)).status, 401);
    for (const bearer of [cashierToken, adminToken, otherOwnerToken]) {
      assert.equal((await api(path(), bearer)).status, 403);
      assert.equal((await upload(bearer)).status, 403);
    }
  });
  it('uploads a real image, serves it and documents the endpoints', async () => {
    const result = await upload();
    assert.equal(result.status, 201, JSON.stringify(result.body));
    poster = result.body;
    assert.equal(poster.durationSeconds, 8);
    assert.equal(poster.enabled, true);
    assert.equal(poster.chainId, chain.id);
    const image = await fetch(base + poster.imageUrl);
    assert.equal(image.status, 200);
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
    const spec = await (await fetch(base + '/api/docs-json')).json();
    assert.ok(spec.paths['/api/v1/restaurant-chains/{chainId}/display-posters'].post);
  });
  it('rejects missing, fake and oversized images', async () => {
    assert.equal((await api(path(), token, 'POST', new FormData())).status, 400);
    assert.equal((await upload(token, Buffer.from('<html>bad</html>'))).status, 400);
    assert.equal((await upload(token, Buffer.alloc(5 * 1024 * 1024 + 1))).status, 413);
  });
  it('edits metadata, validates JSON and hides foreign IDs', async () => {
    const result = await api(`${path()}/${poster.id}`, token, 'PATCH', {
      title: ' Summer ',
      sortOrder: 2,
      durationSeconds: 12,
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.title, 'Summer');
    for (const body of [
      {},
      { enabled: null },
      { enabled: 'false' },
      { title: '' },
      { durationSeconds: 2 },
      { durationSeconds: 61 },
      { sortOrder: -1 },
      { imageUrl: 'https://evil.test' },
    ])
      assert.equal((await api(`${path()}/${poster.id}`, token, 'PATCH', body)).status, 400);
    assert.equal(
      (
        await api(
          `/restaurant-chains/${otherChain.id}/display-posters/${poster.id}`,
          otherOwnerToken,
          'PATCH',
          { enabled: false },
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await api(
          `/restaurant-chains/${otherChain.id}/display-posters/${poster.id}`,
          otherOwnerToken,
          'DELETE',
        )
      ).status,
      404,
    );
  });
  it('device context returns ordered enabled posters only without changing cart version', async () => {
    const second = await upload();
    assert.equal(second.status, 201);
    await api(`${path()}/${second.body.id}`, token, 'PATCH', { sortOrder: 1 });
    await db.displayPoster.create({
      data: { chainId: otherChain.id, title: 'Foreign', imageUrl: '/uploads/posters/foreign.png' },
    });
    let context = await api('/public/customer-display/context', deviceToken);
    assert.equal(context.status, 200);
    assert.equal(context.body.version, 42);
    assert.equal(context.body.snapshot.totalAmount, 123);
    assert.deepEqual(
      context.body.posters.map((p) => p.id),
      [second.body.id, poster.id],
    );
    assert.deepEqual(Object.keys(context.body.posters[0]).sort(), [
      'durationSeconds',
      'id',
      'imageUrl',
      'title',
    ]);
    await api(`${path()}/${second.body.id}`, token, 'PATCH', { enabled: false });
    context = await api('/public/customer-display/context', deviceToken);
    assert.deepEqual(
      context.body.posters.map((p) => p.id),
      [poster.id],
    );
    assert.equal((await api(path())).body.length, 2);
  });
  it('soft deletion hides poster, retains image and rejects repeat edits', async () => {
    assert.equal((await api(`${path()}/${poster.id}`, token, 'DELETE')).status, 200);
    assert.ok((await db.displayPoster.findUnique({ where: { id: poster.id } })).deletedAt);
    assert.equal((await fetch(base + poster.imageUrl)).status, 200);
    assert.deepEqual((await api('/public/customer-display/context', deviceToken)).body.posters, []);
    assert.equal(
      (await api(`${path()}/${poster.id}`, token, 'PATCH', { enabled: true })).status,
      404,
    );
  });
  it('concurrent uploads cannot exceed ten, rejected files are cleaned', async () => {
    const count = await db.displayPoster.count({ where: { chainId: chain.id, deletedAt: null } });
    for (let i = count; i < 9; i++) assert.equal((await upload()).status, 201);
    const filesBefore = await readdir(join(process.env.UPLOAD_DIR, 'posters'));
    const results = await Promise.all([upload(), upload(), upload()]);
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409, 409]);
    assert.equal(
      await db.displayPoster.count({ where: { chainId: chain.id, deletedAt: null } }),
      10,
    );
    assert.equal(
      (await readdir(join(process.env.UPLOAD_DIR, 'posters'))).length,
      filesBefore.length + 1,
    );
  });
  it('expired subscriptions are read-only, invalid/revoked tokens cannot fetch context', async () => {
    await db.businessSubscription.update({
      where: { chainId: chain.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    assert.equal((await api(path())).status, 200);
    assert.equal((await upload()).status, 403);
    assert.equal((await api('/public/customer-display/context', null)).status, 403);
    await db.displayDevice.update({ where: { id: device.id }, data: { revokedAt: new Date() } });
    assert.equal((await api('/public/customer-display/context', deviceToken)).status, 403);
  });
});
