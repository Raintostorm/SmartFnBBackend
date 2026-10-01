import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RealtimeGateway } from '../dist/realtime/realtime.gateway.js';

describe('V9 realtime device authentication', () => {
  it('connects a customer display only to its station room', async () => {
    const joined = [];
    const emitted = [];
    const gateway = new RealtimeGateway(
      { authenticateAccessToken: async () => { throw new Error('not a user token'); } },
      { get: () => true },
      {
        displayDevice: {
          findFirst: async () => ({
            id: 'device-id', type: 'CUSTOMER_DISPLAY', branchId: 'branch-a', stationId: 'station-a',
          }),
          update: async () => ({}),
        },
      },
    );
    const client = {
      id: 'socket-id',
      data: {},
      handshake: { auth: { token: 'device-token' }, headers: {} },
      join: async (room) => joined.push(room),
      emit: (event, data) => emitted.push({ event, data }),
      disconnect: () => assert.fail('valid device must not be disconnected'),
    };
    await gateway.handleConnection(client);
    assert.deepEqual(joined, ['station:station-a']);
    assert.equal(emitted[0].data.kind, 'DEVICE');
  });

  it('connects a calling display only to its branch calling room', async () => {
    const joined = [];
    const gateway = new RealtimeGateway(
      { authenticateAccessToken: async () => { throw new Error('not a user token'); } },
      { get: () => true },
      {
        displayDevice: {
          findFirst: async () => ({
            id: 'device-id', type: 'CALLING_DISPLAY', branchId: 'branch-a', stationId: null,
          }),
          update: async () => ({}),
        },
      },
    );
    await gateway.handleConnection({
      id: 'socket-id', data: {},
      handshake: { auth: { token: 'device-token' }, headers: {} },
      join: async (room) => joined.push(room), emit: () => undefined,
      disconnect: () => assert.fail('valid device must not be disconnected'),
    });
    assert.deepEqual(joined, ['calling-display:branch-a']);
  });

  it('lets only a cashier in the station branch publish a versioned cart', async () => {
    let mutation;
    let room;
    let published;
    const gateway = new RealtimeGateway(
      {},
      {},
      {
        posStation: {
          findFirst: async ({ where }) => {
            assert.equal(where.branchId, 'branch-a');
            return { id: 'station-a' };
          },
          update: async (args) => { mutation = args; return { cartVersion: 8 }; },
        },
      },
    );
    gateway.server = {
      to: (target) => {
        room = target;
        return { emit: (_event, value) => { published = value; } };
      },
    };
    const result = await gateway.updateCart(
      {
        data: {
          user: {
            role: 'CASHIER', employeeId: 'cashier-id', branchId: 'branch-a',
          },
        },
      },
      { stationId: 'station-a', items: [{ name: 'Trà sữa' }], totalAmount: 45000 },
    );
    assert.deepEqual(mutation.data, { cartVersion: { increment: 1 } });
    assert.equal(room, 'station:station-a');
    assert.equal(published.data.version, 8);
    assert.equal(result.data.version, 8);
  });

  it('rejects cart updates sent by a display device', async () => {
    const gateway = new RealtimeGateway({}, {}, {});
    await assert.rejects(
      gateway.updateCart(
        { data: { device: { id: 'device-id', type: 'CUSTOMER_DISPLAY' } } },
        { stationId: 'station-a', items: [] },
      ),
      /Only an assigned cashier/,
    );
  });
});
