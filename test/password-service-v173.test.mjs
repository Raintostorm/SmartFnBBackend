import assert from 'node:assert/strict';
import { test } from 'node:test';
import { argon2id, hash as argon2Hash } from 'argon2';
import { PasswordService } from '../dist/modules/auth/password.service.js';

test('new passwords use bcrypt while existing Argon2 accounts remain able to log in', async () => {
  const passwords = new PasswordService();
  const bcrypt = await passwords.hash('NewPassword123');
  assert.match(bcrypt, /^\$2[aby]\$/);
  assert.equal(await passwords.verify(bcrypt, 'NewPassword123'), true);
  assert.equal(await passwords.verify(bcrypt, 'wrong'), false);
  const legacy = await argon2Hash('LegacyPassword123', { type: argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
  assert.equal(await passwords.verify(legacy, 'LegacyPassword123'), true);
});
