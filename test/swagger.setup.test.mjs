import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { SWAGGER_DESCRIPTION, SWAGGER_DEVICE_TOKEN, SWAGGER_TAGS } from '../dist/swagger.setup.js';

async function controllerFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return controllerFiles(path);
      return entry.name.endsWith('.controller.ts') ? [path] : [];
    }),
  );
  return nested.flat();
}

describe('Swagger V9.1 contract', () => {
  it('removes the old V8 introduction and documents the current counter flow', () => {
    assert.match(SWAGGER_DESCRIPTION, /Smart F&B API V9\.1/);
    assert.match(SWAGGER_DESCRIPTION, /Cashier → Barista/);
    assert.match(SWAGGER_DESCRIPTION, /QR PayOS có hạn 10 phút/);
    assert.doesNotMatch(SWAGGER_DESCRIPTION, /V8/);
    assert.equal(SWAGGER_DEVICE_TOKEN, 'display-device-token');
  });

  it('declares every tag used by a controller exactly once', async () => {
    const declared = SWAGGER_TAGS.map(([name]) => name);
    assert.equal(new Set(declared).size, declared.length);
    const used = new Set();
    for (const file of await controllerFiles(join(process.cwd(), 'src'))) {
      const source = await readFile(file, 'utf8');
      for (const match of source.matchAll(/ApiTags\('([^']+)'\)/g)) used.add(match[1]);
    }
    assert.deepEqual(
      [...used].filter((tag) => !declared.includes(tag)),
      [],
    );
  });
});
