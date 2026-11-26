import { readFileSync } from 'node:fs';

/**
 * Shared, email-client-safe layout for every Smart F&B transactional email.
 * Table layout + inline styles only (Gmail/Outlook strip <style> and flexbox).
 * Colors mirror PLATFORM_BRAND / NEUTRAL tokens in the web app (src/theme/tokens.ts).
 */
const COLOR = {
  brand: '#0a0a0a',
  brandContrast: '#ffffff',
  ink: '#1A1D21',
  muted: '#6B7280',
  paper: '#F6F6F7',
  surface: '#ffffff',
  line: '#e4e4e7',
  subtle: '#fafafa',
  warningBg: '#FFFBE6',
  warningText: '#AD6800',
  warningBorder: '#FFE58F',
  errorBg: '#FFF1F0',
  errorText: '#CF1322',
  errorBorder: '#FFA39E',
} as const;

/**
 * Same typeface as the web app (HarmonyOS Sans, `src/index.css`). Clients that load web fonts (Apple Mail, iOS Mail,
 * Outlook for Mac, Samsung Mail) use it via the @font-face from `withEmailFonts`; Gmail and Outlook for Windows ignore
 * web fonts and fall back to the system fonts after it.
 */
export const EMAIL_FONT = "'HarmonyOS Sans', 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
const FONT = EMAIL_FONT;

/** Font files the web app serves from `public/fonts` (Smart_FnB_Web_Version). */
const EMAIL_FONT_FILES = [
  { weight: 400, file: 'HarmonyOS_Sans_Regular.ttf' },
  { weight: 500, file: 'HarmonyOS_Sans_Medium.ttf' },
  { weight: 600, file: 'HarmonyOS_Sans_Medium.ttf' },
  { weight: 700, file: 'HarmonyOS_Sans_Bold.ttf' },
] as const;

/**
 * Adds the HarmonyOS Sans @font-face rules (files hosted by the web app at PUBLIC_WEB_URL) to a rendered email.
 * Inline styles still carry the full fallback stack, so clients that strip <style> keep a system font.
 */
export function withEmailFonts(html: string, publicWebUrl: string): string {
  const base = publicWebUrl.replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) return html;
  const faces = EMAIL_FONT_FILES.map(
    ({ weight, file }) =>
      `@font-face{font-family:'HarmonyOS Sans';src:url('${escapeHtml(`${base}/fonts/${file}`)}') format('truetype');font-weight:${weight};font-style:normal;font-display:swap}`,
  ).join('');
  return html.replace('</head>', `<style>${faces}</style></head>`);
}

/** Inline (CID) logo: renders without a public asset host and is not blocked like data: URIs. */
export const LOGO_CONTENT_ID = 'smartfnb-logo';
let cachedLogo: string | null | undefined;

/** Base64 logo bundled in <app root>/assets/email (copied into the Docker image with assets/). */
export function emailLogoBase64(): string | null {
  if (cachedLogo === undefined) {
    try {
      cachedLogo = readFileSync(new URL('../../../assets/email/logo.png', import.meta.url)).toString('base64');
    } catch {
      cachedLogo = null;
    }
  }
  return cachedLogo;
}

export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[char]!,
  );
}

export type EmailDetail = { label: string; value: string };
export type EmailNotice = { tone: 'neutral' | 'warning' | 'error'; title?: string; text: string };

export type EmailLayoutInput = {
  /** Hidden inbox preview text. */
  preheader: string;
  /** Small uppercase label above the title, e.g. the recipient's role. */
  eyebrow: string;
  title: string;
  greeting?: string;
  /** Plain-text paragraphs; escaped here. */
  paragraphs: string[];
  details?: EmailDetail[];
  /** Pre-rendered trusted HTML (e.g. an invoice table) placed after the details. */
  extraHtml?: string;
  notice?: EmailNotice;
  cta?: { label: string; url: string };
  /** Show the raw link under the button for clients that block buttons. */
  showFallbackLink?: boolean;
  /** Small print under the CTA (plain text). */
  footnotes?: string[];
  hasLogo: boolean;
};

const p = (text: string, style = '') =>
  `<p style="margin:0 0 14px;font-family:${FONT};font-size:15px;line-height:24px;color:${COLOR.ink};${style}">${text}</p>`;

function detailsTable(details: EmailDetail[]): string {
  const rows = details
    .map(
      (row, index) =>
        `<tr><td style="padding:12px 16px;font-family:${FONT};font-size:13px;color:${COLOR.muted};${index ? `border-top:1px solid ${COLOR.line};` : ''}width:40%;vertical-align:top">${escapeHtml(row.label)}</td>` +
        `<td style="padding:12px 16px;font-family:${FONT};font-size:14px;font-weight:600;color:${COLOR.ink};${index ? `border-top:1px solid ${COLOR.line};` : ''}text-align:right;vertical-align:top">${escapeHtml(row.value)}</td></tr>`,
    )
    .join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 22px;border:1px solid ${COLOR.line};border-radius:10px;background:${COLOR.subtle};border-collapse:separate">${rows}</table>`;
}

function noticeBox(notice: EmailNotice): string {
  const palette =
    notice.tone === 'error'
      ? { bg: COLOR.errorBg, text: COLOR.errorText, border: COLOR.errorBorder }
      : notice.tone === 'warning'
        ? { bg: COLOR.warningBg, text: COLOR.warningText, border: COLOR.warningBorder }
        : { bg: COLOR.subtle, text: COLOR.ink, border: COLOR.line };
  const title = notice.title
    ? `<div style="font-family:${FONT};font-size:13px;font-weight:700;color:${palette.text};margin:0 0 4px;text-transform:uppercase;letter-spacing:.4px">${escapeHtml(notice.title)}</div>`
    : '';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 22px"><tr><td style="padding:14px 16px;background:${palette.bg};border:1px solid ${palette.border};border-left:4px solid ${palette.text};border-radius:8px">${title}<div style="font-family:${FONT};font-size:14px;line-height:22px;color:${palette.text}">${escapeHtml(notice.text)}</div></td></tr></table>`;
}

function button(label: string, url: string): string {
  const href = escapeHtml(url);
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 24px"><tr><td align="center" bgcolor="${COLOR.brand}" style="border-radius:8px;background:${COLOR.brand}">` +
    `<a href="${href}" target="_blank" style="display:inline-block;padding:14px 28px;font-family:${FONT};font-size:15px;font-weight:600;line-height:20px;color:${COLOR.brandContrast};text-decoration:none;border-radius:8px">${escapeHtml(label)}</a>` +
    `</td></tr></table>`;
}

/** Formats a Prisma/ISO date for Vietnamese readers in Vietnam time. */
export function formatVnDateTime(value: string | Date | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function formatVnd(amount: number | undefined): string {
  return `${Number(amount ?? 0).toLocaleString('vi-VN')} ₫`;
}

/** Line-item table for invoices, receipts and subscription notices. */
export function lineItemsTable(lines: Array<{ description: string; quantity: number; amount: number }>, total?: number): string {
  if (!lines.length) return '';
  const cell = `font-family:${FONT};font-size:14px;color:${COLOR.ink};padding:10px 0;border-bottom:1px solid ${COLOR.line}`;
  const rows = lines
    .map(
      (line) =>
        `<tr><td style="${cell}">${escapeHtml(line.description)}</td><td style="${cell};text-align:center;color:${COLOR.muted};white-space:nowrap">× ${escapeHtml(String(line.quantity))}</td><td style="${cell};text-align:right;white-space:nowrap">${escapeHtml(formatVnd(line.amount))}</td></tr>`,
    )
    .join('');
  const totalRow =
    total !== undefined
      ? `<tr><td colspan="2" style="font-family:${FONT};font-size:14px;font-weight:700;color:${COLOR.ink};padding:14px 0 0">Tổng cộng</td><td style="font-family:${FONT};font-size:16px;font-weight:700;color:${COLOR.ink};padding:14px 0 0;text-align:right;white-space:nowrap">${escapeHtml(formatVnd(total))}</td></tr>`
      : '';
  const head = `font-family:${FONT};font-size:12px;font-weight:600;color:${COLOR.muted};text-transform:uppercase;letter-spacing:.4px;padding:0 0 8px;border-bottom:1px solid ${COLOR.line}`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 24px"><tr><td style="${head}">Hạng mục</td><td style="${head};text-align:center">SL</td><td style="${head};text-align:right">Thành tiền</td></tr>${rows}${totalRow}</table>`;
}

export function renderEmailLayout(input: EmailLayoutInput): string {
  const year = new Date().getFullYear();
  const logo = input.hasLogo
    ? `<img src="cid:${LOGO_CONTENT_ID}" width="164" height="57" alt="Smart F&amp;B Platform" style="display:block;border:0;outline:none;height:57px;width:164px">`
    : `<span style="font-family:${FONT};font-size:22px;font-weight:700;color:${COLOR.brand}">Smart F&amp;B Platform</span>`;
  const greeting = input.greeting ? p(escapeHtml(input.greeting)) : '';
  const paragraphs = input.paragraphs.map((text) => p(escapeHtml(text))).join('');
  const details = input.details?.length ? detailsTable(input.details) : '';
  const notice = input.notice ? noticeBox(input.notice) : '';
  const cta = input.cta ? button(input.cta.label, input.cta.url) : '';
  const fallback =
    input.cta && input.showFallbackLink
      ? `<p style="margin:0 0 14px;font-family:${FONT};font-size:12px;line-height:18px;color:${COLOR.muted}">Nếu nút không hoạt động, hãy sao chép liên kết sau vào trình duyệt:<br><a href="${escapeHtml(input.cta.url)}" style="color:${COLOR.ink};word-break:break-all">${escapeHtml(input.cta.url)}</a></p>`
      : '';
  const footnotes = (input.footnotes ?? [])
    .map((text) => `<p style="margin:0 0 8px;font-family:${FONT};font-size:13px;line-height:20px;color:${COLOR.muted}">${escapeHtml(text)}</p>`)
    .join('');

  return `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><title>${escapeHtml(input.title)}</title></head>
<body style="margin:0;padding:0;background:${COLOR.paper};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${escapeHtml(input.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${COLOR.paper}"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px">
<tr><td style="padding:0 4px 20px">${logo}</td></tr>
<tr><td style="background:${COLOR.surface};border:1px solid ${COLOR.line};border-radius:14px;overflow:hidden">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td style="height:4px;line-height:4px;font-size:0;background:${COLOR.brand}">&nbsp;</td></tr>
<tr><td style="padding:32px 36px 12px">
<div style="font-family:${FONT};font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:${COLOR.muted};margin:0 0 8px">${escapeHtml(input.eyebrow)}</div>
<h1 style="margin:0 0 20px;font-family:${FONT};font-size:24px;line-height:32px;font-weight:700;color:${COLOR.ink}">${escapeHtml(input.title)}</h1>
${greeting}${paragraphs}${details}${input.extraHtml ?? ''}${notice}${cta}${fallback}
</td></tr>
${footnotes ? `<tr><td style="padding:0 36px 28px"><div style="border-top:1px solid ${COLOR.line};padding-top:18px">${footnotes}</div></td></tr>` : ''}
</table>
</td></tr>
<tr><td style="padding:24px 8px 0;text-align:center;font-family:${FONT};font-size:12px;line-height:18px;color:${COLOR.muted}">
Email này được gửi tự động từ Smart F&amp;B Platform, vui lòng không trả lời trực tiếp.<br>© ${year} Smart F&amp;B Platform. Nền tảng quản lý chuỗi F&amp;B.
</td></tr>
</table>
</td></tr></table>
</body></html>`;
}
