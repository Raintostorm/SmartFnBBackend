import { resolve } from 'node:path';
import { getUploadRootDirectory } from '../branding/branding-upload.js';

export const MENU_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const MENU_IMAGE_PUBLIC_PREFIX = '/uploads/menu';

export function getMenuImageDirectory(): string {
  return resolve(getUploadRootDirectory(), 'menu');
}
