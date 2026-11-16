import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { ExpressAdapter } from '@nestjs/platform-express';
import { configureApplication } from '../dist/app.setup.js';

test('login uses the default JSON parser while spreadsheet routes accept larger drafts', async () => {
  const adapter = new ExpressAdapter();
  configureApplication({
    get: () => ({ get: (_, fallback) => fallback }),
    use: (...args) => adapter.use(...args),
    setGlobalPrefix() {}, enableCors() {}, useGlobalPipes() {}, enableShutdownHooks() {},
  });
  adapter.registerParserMiddleware('api/v1', false);
  const app = adapter.getInstance();
  app.post('/api/v1/auth/login', (req, res) => res.json(Object.keys(req.body ?? {}).sort()));
  const base = '/api/v1/restaurant-chains/test/menu-imports';
  app.post(base + '/excel', (req, res) => res.json(req.body.rows.length));
  app.put(base + '/sample/draft', (req, res) => res.json(req.body.rows.length));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const send = (path, method, body) => fetch('http://127.0.0.1:' + server.address().port + path, {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    const login = await send('/api/v1/auth/login', 'POST', { email: 'test@example.com', password: 'test-only' });
    assert.deepEqual(await login.json(), ['email', 'password']);
    const draft = { rows: ['x'.repeat(120000)] };
    for (const [path, method] of [['/excel', 'POST'], ['/sample/draft', 'PUT']]) {
      const result = await send(base + path, method, draft);
      assert.equal(result.status, 200);
      assert.equal(await result.json(), 1);
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
