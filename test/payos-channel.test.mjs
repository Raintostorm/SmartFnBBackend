import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PayosChannelService } from '../dist/modules/payos/payos-channel.service.js';
import { PayosCipherService } from '../dist/modules/payos/payos-cipher.service.js';
import { payosSignature, verifyPayosSignature } from '../dist/modules/payos/payos-signature.js';

const masterKey = Buffer.alloc(32, 7).toString('base64');
const cipher = new PayosCipherService({
  get: (name) => (name === 'PAYOS_MASTER_KEY' ? masterKey : undefined),
});
const owner = { role: 'OWNER', ownerId: 'owner-id' };

describe('V9 PayOS channel credentials', () => {
  it('signs fields in stable alphabetical order and rejects changed data', () => {
    const left = payosSignature({ orderCode: 123, amount: 45000 }, 'checksum');
    const right = payosSignature({ amount: 45000, orderCode: 123 }, 'checksum');
    assert.equal(left, right);
    assert.equal(verifyPayosSignature({ amount: 45000, orderCode: 123 }, left, 'checksum'), true);
    assert.equal(verifyPayosSignature({ amount: 45001, orderCode: 123 }, left, 'checksum'), false);
  });

  it('encrypts credentials with authenticated encryption', () => {
    const encrypted = cipher.encrypt('secret-value');
    assert.notEqual(encrypted, 'secret-value');
    assert.equal(cipher.decrypt(encrypted), 'secret-value');
    assert.throws(() => cipher.decrypt(`${encrypted.slice(0, -1)}x`));
  });

  it('stores encrypted values and never returns them to the owner', async () => {
    let stored;
    const service = new PayosChannelService(
      {
        payosChannel: {
          upsert: async (args) => {
            stored = args.create;
            return { id: 'channel-id', createdAt: new Date(0), updatedAt: new Date(0) };
          },
        },
      },
      { assertCanManageChain: async () => undefined },
      cipher,
    );
    const result = await service.save(
      'chain-id',
      { clientId: 'client', apiKey: 'api', checksumKey: 'checksum' },
      owner,
    );
    assert.equal(cipher.decrypt(stored.clientIdCipher), 'client');
    assert.equal(cipher.decrypt(stored.apiKeyCipher), 'api');
    assert.equal(cipher.decrypt(stored.checksumKeyCipher), 'checksum');
    assert.deepEqual(Object.keys(result).sort(), ['configured', 'createdAt', 'id', 'updatedAt']);
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
    );
    const result = await service.get('chain-id', owner);
    assert.equal(result.configured, true);
    assert.equal(result.apiKey, undefined);
    assert.equal(result.checksumKey, undefined);
  });
});
