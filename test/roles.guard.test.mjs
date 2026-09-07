import 'reflect-metadata';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Reflector } from '@nestjs/core';
import { AppRole } from '../dist/modules/auth/app-role.enum.js';
import { ROLES_KEY } from '../dist/modules/auth/auth.constants.js';
import { RolesGuard } from '../dist/modules/auth/guards/roles.guard.js';

function createContext(role, requiredRoles) {
  class TestController {}
  const handler = () => undefined;
  Reflect.defineMetadata(ROLES_KEY, requiredRoles, handler);

  return {
    getHandler: () => handler,
    getClass: () => TestController,
    switchToHttp: () => ({
      getRequest: () => ({ user: { role } }),
    }),
  };
}

describe('RolesGuard', () => {
  const guard = new RolesGuard(new Reflector());

  it('allows every supported role when that role is required', () => {
    for (const role of Object.values(AppRole)) {
      const context = createContext(role, [role]);
      assert.equal(guard.canActivate(context), true);
    }
  });

  it('denies a user whose role is not required', () => {
    const context = createContext(AppRole.CUSTOMER, [AppRole.ADMIN]);
    assert.throws(() => guard.canActivate(context), /permission/i);
  });
});
