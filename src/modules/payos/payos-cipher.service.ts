import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

@Injectable()
export class PayosCipherService {
  constructor(private readonly config: ConfigService) {}

  encrypt(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(), iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return ['v1', iv, cipher.getAuthTag(), encrypted]
      .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
      .join('.');
  }

  decrypt(value: string): string {
    const [version, ivText, tagText, encryptedText] = value.split('.');
    if (version !== 'v1' || !ivText || !tagText || !encryptedText) {
      throw new ServiceUnavailableException('Stored PayOS credentials are invalid');
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key(), Buffer.from(ivText, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedText, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }

  private key(): Buffer {
    const encoded = this.config.get<string>('PAYOS_MASTER_KEY')?.trim();
    const key = encoded ? Buffer.from(encoded, 'base64') : Buffer.alloc(0);
    if (key.length !== 32) {
      throw new ServiceUnavailableException('PAYOS_MASTER_KEY is not configured');
    }
    return key;
  }
}
