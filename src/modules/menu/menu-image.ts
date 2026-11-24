import { BadRequestException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { basename, resolve } from 'node:path';
import { deleteAsset, putAsset } from '../assets/asset-storage.js';
import { getUploadRootDirectory } from '../branding/branding-upload.js';

export const MENU_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const MENU_IMAGE_PUBLIC_PREFIX = '/uploads/menu';

export type MenuImageFile = { buffer: Buffer; mimetype: string; size: number };

export function getMenuImageDirectory(): string {
  return resolve(getUploadRootDirectory(), 'menu');
}

/** Validates size and magic bytes (the declared MIME type alone is not trusted). */
export function menuImageExtension(file: MenuImageFile | undefined): 'jpg' | 'png' | 'webp' {
  if (!file?.buffer?.length) throw new BadRequestException('An image file is required');
  if (file.size > MENU_IMAGE_MAX_BYTES || file.buffer.length > MENU_IMAGE_MAX_BYTES)
    throw new BadRequestException('Menu image must not exceed 5 MB');
  const b = file.buffer;
  if (file.mimetype === 'image/jpeg' && b.length >= 3 && b.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'jpg';
  if (file.mimetype === 'image/png' && b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (file.mimetype === 'image/webp' && b.length >= 12 && b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  throw new BadRequestException('Menu image must be a valid JPEG, PNG, or WebP file');
}

/**
 * Stores a validated menu image, persists its public URL, then removes the previous
 * uploaded file. The new file is rolled back if persisting fails; external URLs are never deleted.
 */
export async function replaceMenuImage<T>(
  chainId: string,
  entityId: string,
  file: MenuImageFile | undefined,
  previousUrl: string | null,
  persist: (imageUrl: string) => Promise<T>,
): Promise<T> {
  const ext = menuImageExtension(file);
  const fileName = `${chainId}-${entityId}-${randomUUID()}.${ext}`;
  const key = `menu/${fileName}`;
  await putAsset(key, file!.buffer);
  let saved: T;
  try {
    saved = await persist(`${MENU_IMAGE_PUBLIC_PREFIX}/${fileName}`);
  } catch (error) {
    await deleteAsset(key).catch(() => undefined);
    throw error;
  }
  if (previousUrl?.startsWith(`${MENU_IMAGE_PUBLIC_PREFIX}/`)) {
    const oldName = previousUrl.slice(MENU_IMAGE_PUBLIC_PREFIX.length + 1);
    if (oldName && basename(oldName) === oldName) await deleteAsset(`menu/${oldName}`).catch(() => undefined);
  }
  return saved;
}
