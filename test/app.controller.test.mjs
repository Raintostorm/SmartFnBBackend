import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AppController } from '../dist/app.controller.js';
import { AppService } from '../dist/app.service.js';

describe('AppController', () => {
  it('returns the service health state', () => {
    const controller = new AppController(new AppService());
    const health = controller.getHealth();

    assert.equal(health.status, 'ok');
    assert.equal(health.service, 'smart-fnb-backend');
    assert.doesNotThrow(() => new Date(health.timestamp));
  });
});
