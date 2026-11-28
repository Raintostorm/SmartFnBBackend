import { BadRequestException } from '@nestjs/common';

/** Phần Store Manager tuỳ biến ở cuối hoá đơn; `null` ở từng trường nghĩa là không in dòng đó. */
export interface ReceiptFooter {
  wifiName: string | null;
  wifiPassword: string | null;
  reviewUrl: string | null;
  note: string | null;
}

export interface ReceiptSettingsInput {
  wifiName?: string | null;
  wifiPassword?: string | null;
  reviewUrl?: string | null;
  footerNote?: string | null;
}

type StoredReceiptSetting = {
  wifiName: string | null;
  wifiPassword: string | null;
  reviewUrl: string | null;
  footerNote: string | null;
} | null;

export const RECEIPT_LIMITS = { wifiName: 32, wifiPassword: 63, reviewUrl: 500, footerNote: 120 } as const;

/** Tên miền của link Google Maps / Google Business; link đánh giá nằm ở một trong các host này. */
const GOOGLE_SHORT_HOSTS = new Set(['maps.app.goo.gl', 'goo.gl', 'g.page', 'g.co']);

function isGoogleHost(host: string) {
  if (GOOGLE_SHORT_HOSTS.has(host)) return true;
  // google.com, www.google.com.vn, maps.google.com, search.google.com…
  return /^([a-z0-9-]+\.)*google\.[a-z]{2,3}(\.[a-z]{2})?$/.test(host);
}

function text(value: string | null | undefined) {
  if (value === undefined) return undefined;
  const trimmed = value?.trim() ?? '';
  return trimmed ? trimmed : null;
}

/** Chuẩn hoá link đánh giá; chỉ nhận https thuộc Google để QR in ra không dẫn khách tới trang lạ. */
export function normalizeReviewUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BadRequestException('reviewUrl must be a valid URL');
  }
  if (url.protocol !== 'https:') throw new BadRequestException('reviewUrl must use https');
  if (!isGoogleHost(url.hostname.toLowerCase())) {
    throw new BadRequestException('reviewUrl must be a Google Maps link');
  }
  // `href` đã mã hoá về ASCII, đúng dữ liệu mà lệnh QR của máy in nhiệt nhận được.
  if (url.href.length > RECEIPT_LIMITS.reviewUrl) {
    throw new BadRequestException(`reviewUrl must be at most ${RECEIPT_LIMITS.reviewUrl} characters`);
  }
  return url.href;
}

/** Kiểm tra và chuẩn hoá dữ liệu PUT; trường không gửi (`undefined`) giữ nguyên giá trị cũ. */
export function validateReceiptSettings(input: ReceiptSettingsInput) {
  const wifiName = text(input.wifiName);
  const wifiPassword = text(input.wifiPassword);
  const reviewUrl = text(input.reviewUrl);
  const footerNote = text(input.footerNote);
  if (wifiName && wifiName.length > RECEIPT_LIMITS.wifiName) {
    throw new BadRequestException(`wifiName must be at most ${RECEIPT_LIMITS.wifiName} characters`);
  }
  if (wifiPassword) {
    if (wifiPassword.length > RECEIPT_LIMITS.wifiPassword) {
      throw new BadRequestException(
        `wifiPassword must be at most ${RECEIPT_LIMITS.wifiPassword} characters`,
      );
    }
    // Máy in chế độ chữ chỉ in đúng ASCII; ký tự khác sẽ thành "?" và khách không vào được wifi.
    if (!/^[\x20-\x7e]+$/.test(wifiPassword)) {
      throw new BadRequestException('wifiPassword may contain only ASCII characters');
    }
  }
  if (footerNote && footerNote.length > RECEIPT_LIMITS.footerNote) {
    throw new BadRequestException(
      `footerNote must be at most ${RECEIPT_LIMITS.footerNote} characters`,
    );
  }
  return {
    wifiName,
    wifiPassword,
    reviewUrl: reviewUrl ? normalizeReviewUrl(reviewUrl) : reviewUrl,
    footerNote,
  };
}

/** Dữ liệu in cuối hoá đơn; chi nhánh chưa cấu hình gì thì trả về các trường `null`. */
export function receiptFooter(setting: StoredReceiptSetting): ReceiptFooter {
  return {
    wifiName: setting?.wifiName ?? null,
    wifiPassword: setting?.wifiPassword ?? null,
    reviewUrl: setting?.reviewUrl ?? null,
    note: setting?.footerNote ?? null,
  };
}
