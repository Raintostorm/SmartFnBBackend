import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PayosChannelService } from '../dist/modules/payos/payos-channel.service.js';
import { PayosApiError, PayosApiService } from '../dist/modules/payos/payos-api.service.js';
import { PayosPaymentService } from '../dist/modules/payos/payos-payment.service.js';
import { PayosVerificationStore } from '../dist/modules/payos/payos-verification.store.js';
import { PayosCipherService } from '../dist/modules/payos/payos-cipher.service.js';
import { payosSignature, verifyPayosSignature } from '../dist/modules/payos/payos-signature.js';

const masterKey = Buffer.alloc(32, 7).toString('base64');
const cipher = new PayosCipherService({
  get: (name) => (name === 'PAYOS_MASTER_KEY' ? masterKey : undefined),
});
const owner = { role: 'OWNER', ownerId: 'owner-id' };
const config = {
  get: (name) => (name === 'PAYOS_WEBHOOK_BASE_URL' ? 'https://api.example.com/api/v1' : undefined),
};
const verification = { put: () => undefined, remove: () => undefined };

describe('V9 PayOS channel credentials', () => {
  it('signs fields in stable alphabetical order and rejects changed data', () => {
    const left = payosSignature({ orderCode: 123, amount: 45000 }, 'checksum');
    const right = payosSignature({ amount: 45000, orderCode: 123 }, 'checksum');
    assert.equal(left, right);
    assert.equal(verifyPayosSignature({ amount: 45000, orderCode: 123 }, left, 'checksum'), true);
    assert.equal(verifyPayosSignature({ amount: 45001, orderCode: 123 }, left, 'checksum'), false);
  });

  it('encrypts credentials with authenticated encryption', () => {
    assert.doesNotThrow(() => cipher.assertConfigured());
    const encrypted = cipher.encrypt('secret-value');
    assert.notEqual(encrypted, 'secret-value');
    assert.equal(cipher.decrypt(encrypted), 'secret-value');
    assert.throws(() => cipher.decrypt(`${encrypted.slice(0, -1)}x`));
  });

  it('rejects a missing master key before changing the PayOS webhook', async () => {
    let payosCalls = 0;
    const service = new PayosChannelService(
      {
        payosChannel: {
          findUnique: () => assert.fail('configuration must be checked before reading the channel'),
        },
      },
      { assertCanManageChain: async () => undefined },
      new PayosCipherService({ get: () => undefined }),
      {
        confirmWebhook: async () => {
          payosCalls += 1;
        },
      },
      config,
      verification,
    );

    await assert.rejects(
      service.save(
        'chain-id',
        { clientId: 'client', apiKey: 'api', checksumKey: 'checksum' },
        owner,
      ),
      (error) =>
        error?.getStatus?.() === 503 && error?.message === 'PAYOS_MASTER_KEY is not configured',
    );
    assert.equal(payosCalls, 0);
  });

  it('calls the official PayOS confirm-webhook endpoint with channel headers', async () => {
    const originalFetch = globalThis.fetch;
    let request;
    globalThis.fetch = async (url, init) => {
      request = { url, init };
      return new Response(JSON.stringify({ code: '00', desc: 'success', data: {} }), {
        status: 200,
      });
    };
    try {
      await new PayosApiService().confirmWebhook(
        { clientId: 'client', apiKey: 'api', checksumKey: 'checksum' },
        'https://merchant.example/api/v1/webhooks/payos/code',
      );
      assert.equal(request.url, 'https://api-merchant.payos.vn/confirm-webhook');
      assert.equal(request.init.headers['x-client-id'], 'client');
      assert.equal(request.init.headers['x-api-key'], 'api');
      assert.deepEqual(JSON.parse(request.init.body), {
        webhookUrl: 'https://merchant.example/api/v1/webhooks/payos/code',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('reads and cancels a payment through the official PayOS API', async () => {
    const originalFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (url, init) => {
      requests.push({ url, init });
      return new Response(
        JSON.stringify({ code: '00', data: { id: 'link-id', status: 'CANCELLED' } }),
        { status: 200 },
      );
    };
    try {
      const api = new PayosApiService();
      const credentials = { clientId: 'client', apiKey: 'api', checksumKey: 'checksum' };
      await api.getPayment(credentials, 'link/id');
      await api.cancelPayment(credentials, 'link/id', 'Khách đổi phương thức thanh toán');
      assert.equal(requests[0].init.method, 'GET');
      assert.equal(requests[0].init.body, undefined);
      assert.match(requests[0].url, /payment-requests\/link%2Fid$/);
      assert.equal(requests[1].init.method, 'POST');
      assert.match(requests[1].url, /payment-requests\/link%2Fid\/cancel$/);
      assert.deepEqual(JSON.parse(requests[1].init.body), {
        cancellationReason: 'Khách đổi phương thức thanh toán',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('accepts a correctly signed PayOS verification callback without an order', async () => {
    const store = new PayosVerificationStore();
    const webhookCode = '123e4567-e89b-12d3-a456-426614174000';
    const data = { orderCode: 123, amount: 1000, description: 'sample' };
    store.put(webhookCode, 'chain-id', 'checksum');
    const service = new PayosPaymentService(
      {
        payosChannel: {
          findUnique: () => assert.fail('pending verification must be checked first'),
        },
      },
      {},
      cipher,
      {},
      {},
      store,
    );
    await assert.doesNotReject(
      service.webhook(webhookCode, {
        code: '00',
        success: true,
        data,
        signature: payosSignature(data, 'checksum'),
      }),
    );
  });

  it('marks a channel ERROR when PayOS rejects its keys while creating a QR', async () => {
    let channelUpdate;
    const service = new PayosPaymentService(
      {
        payment: { updateMany: async () => ({ count: 0 }) },
        order: {
          findFirst: async () => ({
            id: 'order-id',
            status: 'CONFIRMED',
            paymentStatus: 'UNPAID',
            totalAmount: '10000',
            orderCode: 'ORD-1',
            branch: { chainId: 'chain-id' },
            payments: [],
          }),
        },
        posStation: { findFirst: async () => ({ id: 'station-id' }) },
        payosChannel: {
          findUnique: async () => ({
            id: 'channel-id',
            clientIdCipher: cipher.encrypt('client'),
            apiKeyCipher: cipher.encrypt('api'),
            checksumKeyCipher: cipher.encrypt('checksum'),
          }),
          update: async (args) => {
            channelUpdate = args.data;
          },
        },
      },
      { assertSubscriptionAllowsWrite: async () => undefined },
      cipher,
      {
        createPayment: async () => {
          throw new PayosApiError('Invalid API key', false, 401);
        },
      },
      {},
      { get: () => null },
    );
    await assert.rejects(
      service.create({ employeeId: 'employee-id', branchId: 'branch-id' }, 'order-id', {
        stationId: 'station-id',
        cancelUrl: 'https://example.com/cancel',
        returnUrl: 'https://example.com/return',
      }),
      (error) => error?.getStatus?.() === 400,
    );
    assert.equal(channelUpdate.status, 'ERROR');
    assert.equal(channelUpdate.lastError, 'Invalid API key');
  });

  it('stores encrypted values and never returns them to the owner', async () => {
    let stored;
    let confirmedUrl;
    let auditAction;
    const db = {
      payosChannel: { findUnique: async () => null },
      payosChannelAuditLog: { create: async () => ({}) },
      $transaction: async (work) =>
        work({
          payosChannel: {
            upsert: async (args) => {
              stored = args.create;
              return {
                id: 'channel-id',
                status: 'LINKED',
                clientIdLast4: 'ient',
                apiKeyLast4: 'api',
                lastError: null,
                lastVerifiedAt: new Date(0),
                createdAt: new Date(0),
                updatedAt: new Date(0),
              };
            },
          },
          payosChannelAuditLog: {
            create: async ({ data }) => {
              auditAction = data.action;
              return {};
            },
          },
        }),
    };
    const service = new PayosChannelService(
      db,
      { assertCanManageChain: async () => undefined },
      cipher,
      {
        confirmWebhook: async (_credentials, url) => {
          confirmedUrl = url;
        },
      },
      config,
      verification,
    );
    const result = await service.save(
      'chain-id',
      { clientId: 'client', apiKey: 'api', checksumKey: 'checksum' },
      owner,
    );
    assert.equal(cipher.decrypt(stored.clientIdCipher), 'client');
    assert.equal(cipher.decrypt(stored.apiKeyCipher), 'api');
    assert.equal(cipher.decrypt(stored.checksumKeyCipher), 'checksum');
    assert.match(confirmedUrl, /^https:\/\/api\.example\.com\/api\/v1\/webhooks\/payos\//);
    assert.equal(result.status, 'LINKED');
    assert.equal(result.clientIdLast4, 'ient');
    assert.equal(result.checksumKey, undefined);
    assert.equal(auditAction, 'PAYOS_CHANNEL_CREATED');
  });

  it('deletes a channel and writes an audit record without credentials', async () => {
    let deletedId;
    let audit;
    const existing = {
      id: 'channel-id',
      status: 'LINKED',
      clientIdLast4: 'last',
      apiKeyLast4: 'key4',
      lastError: null,
      lastVerifiedAt: new Date(0),
      clientIdCipher: 'secret-cipher',
      apiKeyCipher: 'secret-cipher',
      checksumKeyCipher: 'secret-cipher',
    };
    const service = new PayosChannelService(
      {
        payosChannel: { findUnique: async () => existing },
        $transaction: async (work) =>
          work({
            payosChannel: {
              delete: async ({ where }) => {
                deletedId = where.id;
              },
            },
            payosChannelAuditLog: {
              create: async ({ data }) => {
                audit = data;
              },
            },
          }),
      },
      { assertCanManageChain: async () => undefined },
      cipher,
      {},
      config,
      verification,
    );

    assert.deepEqual(await service.remove('chain-id', { ...owner, id: 'user-id' }), {
      configured: false,
    });
    assert.equal(deletedId, 'channel-id');
    assert.equal(audit.action, 'PAYOS_CHANNEL_REMOVED');
    assert.equal(JSON.stringify(audit).includes('secret-cipher'), false);
  });

  it('does not replace existing credentials when PayOS rejects verification', async () => {
    let upserts = 0;
    let audits = 0;
    const service = new PayosChannelService(
      {
        payosChannel: {
          findUnique: async () => ({
            id: 'channel-id',
            webhookCode: '123e4567-e89b-12d3-a456-426614174000',
            status: 'LINKED',
            clientIdLast4: 'old1',
            apiKeyLast4: 'old2',
            lastError: null,
            lastVerifiedAt: new Date(0),
          }),
          upsert: async () => {
            upserts += 1;
          },
        },
        payosChannelAuditLog: {
          create: async () => {
            audits += 1;
          },
        },
      },
      { assertCanManageChain: async () => undefined },
      cipher,
      {
        confirmWebhook: async () => {
          throw new PayosApiError('Invalid API key', false, 401);
        },
      },
      config,
      verification,
    );

    await assert.rejects(
      service.save(
        'chain-id',
        { clientId: 'new', apiKey: 'bad', checksumKey: 'checksum' },
        { ...owner, id: 'user-id' },
      ),
      (error) => error?.getStatus?.() === 422,
    );
    assert.equal(upserts, 0);
    assert.equal(audits, 1);
  });

  it('returns only connection status when reading a channel', async () => {
    const service = new PayosChannelService(
      {
        payosChannel: {
          findUnique: async () => ({
            id: 'channel-id',
            createdAt: new Date(0),
            updatedAt: new Date(0),
          }),
        },
      },
      { assertCanAccessChain: async () => undefined },
      cipher,
      {},
      config,
      verification,
    );
    const result = await service.get('chain-id', owner);
    assert.equal(result.configured, true);
    assert.equal(result.apiKey, undefined);
    assert.equal(result.checksumKey, undefined);
    assert.equal(result.status, undefined);
  });
});
