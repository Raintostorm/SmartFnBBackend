import 'dotenv/config';
import { mkdirSync, openSync, closeSync, existsSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const value = process.env.DATABASE_URL;
if (!value) throw new Error('DATABASE_URL is missing');
const url = new URL(value);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
  throw new Error('This backup helper only accepts a local database');
const directory = resolve(process.cwd(), '../.local-backups/SmartFnBBackend');
mkdirSync(directory, { recursive: true, mode: 0o700 });
const file = resolve(directory, `${new Date().toISOString().replaceAll(':', '-')}.dump`);
const fd = openSync(file, 'wx', 0o600);
const binary =
  process.env.PG_DUMP_BIN ??
  (existsSync('/opt/homebrew/bin/pg_dump') ? '/opt/homebrew/bin/pg_dump' : 'pg_dump');
let result;
try {
  result = spawnSync(binary, ['--format=custom', '--no-owner', '--no-privileges'], {
    env: {
      ...process.env,
      PGHOST: url.hostname,
      PGPORT: url.port || '5432',
      PGUSER: decodeURIComponent(url.username),
      PGPASSWORD: decodeURIComponent(url.password),
      PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    },
    stdio: ['ignore', fd, 'pipe'],
    encoding: 'utf8',
  });
} finally {
  closeSync(fd);
}
if (result.error || result.status !== 0) {
  unlinkSync(file);
  throw new Error(result.error?.message ?? result.stderr);
}
console.log(`Local database backup saved: ${file}`);
