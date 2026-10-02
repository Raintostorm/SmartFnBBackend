import { resolve } from 'node:path';

export const BRANDING_LOGO_MAX_BYTES = 5 * 1024 * 1024;
export const BRANDING_LOGO_PUBLIC_PREFIX = '/uploads/branding';

export function getUploadRootDirectory(): string {
  return resolve(process.cwd(), process.env.UPLOAD_DIR?.trim() || 'uploads');
}

export function getBrandingLogoDirectory(): string {
  return resolve(getUploadRootDirectory(), 'branding');
}
