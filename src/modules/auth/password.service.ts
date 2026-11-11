import { Injectable } from '@nestjs/common';
import { verify as verifyArgon2 } from 'argon2';
import { compare, hash } from 'bcryptjs';

@Injectable()
export class PasswordService {
  hash(password: string): Promise<string> {
    return hash(password, 12);
  }

  verify(passwordHash: string, password: string): Promise<boolean> {
    // Existing accounts were issued with Argon2. Keep them usable until their next password change.
    return passwordHash.startsWith('$argon2')
      ? verifyArgon2(passwordHash, password)
      : compare(password, passwordHash);
  }
}
