import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { getUploadRootDirectory } from '../branding/branding-upload.js';

const allowedKey = /^(menu|branding|posters)\/[a-zA-Z0-9-]+\.(jpg|png|webp)$/;
const mimeTypes: Record<string, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

function assertKey(key: string): void {
  if (!allowedKey.test(key)) throw new Error('Invalid asset key');
}

function localPath(key: string): string {
  assertKey(key);
  const root = getUploadRootDirectory();
  const path = resolve(root, key);
  if (!path.startsWith(`${root}${sep}`)) throw new Error('Invalid asset path');
  return path;
}

const isS3 = () => process.env.ASSET_STORAGE_PROVIDER === 's3';
let client: S3Client | undefined;

function s3(): S3Client {
  if (!client) {
    client = new S3Client({
      region: process.env.ASSET_STORAGE_REGION || 'auto',
      endpoint: process.env.ASSET_STORAGE_ENDPOINT || undefined,
      forcePathStyle: Boolean(process.env.ASSET_STORAGE_ENDPOINT),
      credentials: {
        accessKeyId: process.env.ASSET_STORAGE_ACCESS_KEY_ID!,
        secretAccessKey: process.env.ASSET_STORAGE_SECRET_ACCESS_KEY!,
      },
    });
  }
  return client;
}

export function assetStorageUsesS3(): boolean {
  return isS3();
}

export async function putAsset(key: string, data: Buffer): Promise<void> {
  assertKey(key);
  if (isS3()) {
    await s3().send(
      new PutObjectCommand({
        Bucket: process.env.ASSET_STORAGE_BUCKET!,
        Key: key,
        Body: data,
        ContentType: mimeTypes[key.split('.').at(-1)!],
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );
    return;
  }
  const path = localPath(key);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data, { flag: 'wx' });
}

export async function readAsset(key: string): Promise<{ data: Buffer; contentType: string }> {
  assertKey(key);
  const contentType = mimeTypes[key.split('.').at(-1)!];
  if (isS3()) {
    const object = await s3().send(
      new GetObjectCommand({ Bucket: process.env.ASSET_STORAGE_BUCKET!, Key: key }),
    );
    if (!object.Body) throw new Error('Asset not found');
    return { data: Buffer.from(await object.Body.transformToByteArray()), contentType };
  }
  return { data: await readFile(localPath(key)), contentType };
}

export async function deleteAsset(key: string): Promise<void> {
  assertKey(key);
  if (isS3()) {
    await s3().send(
      new DeleteObjectCommand({ Bucket: process.env.ASSET_STORAGE_BUCKET!, Key: key }),
    );
    return;
  }
  await rm(localPath(key), { force: true });
}
