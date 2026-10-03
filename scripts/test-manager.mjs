import 'dotenv/config';
import { Client } from 'pg';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

// All fixtures and migrations run in a newly created local database, never the developer database.
const adminUrl = new URL(process.env.DATABASE_URL);
if (!['localhost', '127.0.0.1', '::1'].includes(adminUrl.hostname))
  throw new Error('Manager test runner requires a local PostgreSQL DATABASE_URL');
const name = `smart_fnb_manager_test_${Date.now()}_${randomBytes(3).toString('hex')}`;
if (!/^smart_fnb_manager_test_[0-9]+_[a-f0-9]+$/.test(name))
  throw new Error('Invalid test database name');
adminUrl.pathname = '/postgres';
const client = new Client({ connectionString: adminUrl.toString() });
await client.connect();
let created = false;
try {
  await client.query(`CREATE DATABASE "${name}"`);
  created = true;
  const testUrl = new URL(adminUrl);
  testUrl.pathname = `/${name}`;
  const env = {
    ...process.env,
    DATABASE_URL: testUrl.toString(),
    NODE_ENV: 'test',
    REALTIME_ENABLED: 'false',
    SWAGGER_ENABLED: 'true',
    JWT_ACCESS_SECRET: 'manager-tests-access-secret-at-least-32-characters',
    JWT_REFRESH_SECRET: 'manager-tests-refresh-secret-at-least-32-characters',
  };
  const migrate = spawnSync(
    process.execPath,
    [resolve('node_modules/prisma/build/index.js'), 'migrate', 'deploy'],
    { env, stdio: 'inherit' },
  );
  if (migrate.status !== 0) throw new Error('Test database migrations failed');
  const test = spawnSync(process.execPath, ['--test', 'test/branch-manager.e2e.test.mjs'], {
    env,
    stdio: 'inherit',
  });
  process.exitCode = test.status ?? 1;
} finally {
  if (created) {
    // Exact self-created target, validated above; no application data lives in this database.
    await client.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    console.log(`Removed temporary test database ${name}`);
  }
  await client.end();
}
