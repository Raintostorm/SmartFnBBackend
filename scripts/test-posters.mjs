import 'dotenv/config';
import { Client } from 'pg';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const adminUrl = new URL(process.env.DATABASE_URL);
if (!['localhost', '127.0.0.1', '::1'].includes(adminUrl.hostname))
  throw new Error('Requires local PostgreSQL; never run against production');
adminUrl.pathname = '/postgres';
const name = `smart_fnb_poster_test_${Date.now()}_${randomBytes(3).toString('hex')}`;
if (!/^smart_fnb_poster_test_[0-9]+_[a-f0-9]+$/.test(name))
  throw new Error('Invalid test database name');
const uploadDir = await mkdtemp(join(tmpdir(), 'smart-fnb-posters-'));
const client = new Client({ connectionString: adminUrl.toString() });
await client.connect();
let created = false;
try {
  await client.query(`CREATE DATABASE "${name}"`);
  created = true;
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const env = {
    ...process.env,
    DATABASE_URL: url.toString(),
    UPLOAD_DIR: uploadDir,
    NODE_ENV: 'test',
    REALTIME_ENABLED: 'false',
    SWAGGER_ENABLED: 'true',
    JWT_ACCESS_SECRET: 'posters-tests-access-secret-at-least-32-characters',
    JWT_REFRESH_SECRET: 'posters-tests-refresh-secret-at-least-32-characters',
  };
  const migrate = spawnSync(
    process.execPath,
    [resolve('node_modules/prisma/build/index.js'), 'migrate', 'deploy'],
    { env, stdio: 'inherit' },
  );
  if (migrate.status !== 0) throw new Error('Test migrations failed');
  const run = spawnSync(process.execPath, ['--test', 'test/display-posters.e2e.test.mjs'], {
    env,
    stdio: 'inherit',
  });
  process.exitCode = run.status ?? 1;
} finally {
  if (created) await client.query(`DROP DATABASE "${name}" WITH (FORCE)`);
  await client.end();
  // Only the exact, freshly allocated OS temporary directory from mkdtemp above.
  if (
    resolve(uploadDir).startsWith(resolve(tmpdir()) + '\\') &&
    /^smart-fnb-posters-/.test(uploadDir.split(/[\\/]/).at(-1))
  ) {
    await rm(uploadDir, { recursive: true, force: true });
  }
  console.log(`Removed isolated database ${name} and temporary poster fixtures`);
}
