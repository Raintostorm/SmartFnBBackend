import crypto from 'node:crypto';

function value(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function payosSignature(data: Record<string, unknown>, checksumKey: string) {
  const canonical = Object.keys(data)
    .sort()
    .map((key) => `${key}=${value(data[key])}`)
    .join('&');
  return crypto.createHmac('sha256', checksumKey).update(canonical).digest('hex');
}

export function verifyPayosSignature(
  data: Record<string, unknown>,
  signature: string,
  checksumKey: string,
) {
  const expected = Buffer.from(payosSignature(data, checksumKey), 'hex');
  const actual = Buffer.from(signature, 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}
