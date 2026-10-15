import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

@Injectable()
export class ReceiptStorageService {
  private readonly provider: 'local' | 's3';
  private readonly bucket: string;
  private readonly localRoot: string;
  private readonly s3: S3Client | null;

  constructor(private readonly config: ConfigService) {
    const enabled = config.get<boolean>('RECEIPT_PDF_ENABLED', true);
    this.provider = config.get<'local' | 's3'>('RECEIPT_STORAGE_PROVIDER', 'local');
    this.bucket = config.get<string>('RECEIPT_STORAGE_BUCKET', '');
    this.localRoot = resolve(
      process.cwd(),
      config.get<string>('RECEIPT_STORAGE_LOCAL_DIR', 'uploads/receipts'),
    );
    this.s3 =
      enabled && this.provider === 's3'
        ? new S3Client({
            region: config.get<string>('RECEIPT_STORAGE_REGION', 'auto'),
            endpoint: config.get<string>('RECEIPT_STORAGE_ENDPOINT') || undefined,
            forcePathStyle: Boolean(config.get<string>('RECEIPT_STORAGE_ENDPOINT')),
            credentials: {
              accessKeyId: config.getOrThrow<string>('RECEIPT_STORAGE_ACCESS_KEY_ID'),
              secretAccessKey: config.getOrThrow<string>('RECEIPT_STORAGE_SECRET_ACCESS_KEY'),
            },
          })
        : null;
  }

  async put(key: string, data: Buffer): Promise<void> {
    if (this.s3) {
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: data,
          ContentType: 'application/pdf',
          CacheControl: 'private, max-age=31536000, immutable',
        }),
      );
      return;
    }
    const path = this.localPath(key);
    await mkdir(dirname(path), { recursive: true });
    // The key includes a content checksum, so concurrent generators write the
    // same immutable bytes. Overwriting avoids turning a harmless race into a
    // failed receipt document on local storage.
    await writeFile(path, data);
  }

  async access(key: string, orderId: string) {
    if (!this.s3) {
      return {
        downloadUrl: `/api/v1/cashier/orders/${orderId}/receipt-document/download`,
        expiresAt: null,
      };
    }
    const expiresIn = 10 * 60;
    return {
      downloadUrl: await getSignedUrl(
        this.s3,
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
        { expiresIn },
      ),
      expiresAt: new Date(Date.now() + expiresIn * 1000),
    };
  }

  async read(key: string): Promise<Buffer> {
    if (!this.s3) {
      try {
        return await readFile(this.localPath(key));
      } catch {
        throw new NotFoundException('Receipt PDF file was not found');
      }
    }
    const result = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!result.Body) throw new NotFoundException('Receipt PDF file was not found');
    return Buffer.from(await result.Body.transformToByteArray());
  }

  private localPath(key: string) {
    const path = resolve(this.localRoot, key);
    if (!path.startsWith(`${this.localRoot}/`)) throw new NotFoundException('Invalid receipt key');
    return path;
  }
}
