import 'reflect-metadata';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Reflector } from '@nestjs/core';
import { UnauthorizedException } from '@nestjs/common';
import { IS_PUBLIC_KEY } from '../dist/modules/auth/auth.constants.js';
import { JwtAuthGuard } from '../dist/modules/auth/guards/jwt-auth.guard.js';

function createContext(type, request, isPublic = false) {
  class TestController {}
  const handler = () => undefined;
  if (isPublic) Reflect.defineMetadata(IS_PUBLIC_KEY, true, handler);

  return {
    getType: () => type,
    getHandler: () => handler,
    getClass: () => TestController,
    switchToHttp: () => ({ getRequest: () => request }),
  };
}

describe('JwtAuthGuard', () => {
  const authService = { authenticateAccessToken: async (token) => ({ id: token }) };
  const guard = new JwtAuthGuard(new Reflector(), authService);

  it('does not authenticate WebSocket messages (the socket has no headers; auth happens on connection)', async () => {
    // switchToHttp().getRequest() is the Socket for ws contexts — it has no `headers`
    const context = createContext('ws', { id: 'socket-id' });
    assert.equal(await guard.canActivate(context), true);
  });

  it('still requires a Bearer token on HTTP requests', async () => {
    const context = createContext('http', { headers: {} });
    await assert.rejects(() => guard.canActivate(context), UnauthorizedException);
  });

  it('authenticates a valid Bearer token on HTTP requests', async () => {
    const request = { headers: { authorization: 'Bearer abc' } };
    assert.equal(await guard.canActivate(createContext('http', request)), true);
    assert.deepEqual(request.user, { id: 'abc' });
  });

  it('lets @Public() HTTP routes through without a token', async () => {
    const context = createContext('http', { headers: {} }, true);
    assert.equal(await guard.canActivate(context), true);
  });
});
