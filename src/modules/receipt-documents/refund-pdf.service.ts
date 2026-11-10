import { Injectable } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import { fileURLToPath } from 'node:url';

const regularFont = fileURLToPath(new URL('../../../assets/fonts/HarmonyOS_Sans_Regular.ttf', import.meta.url));
const boldFont = fileURLToPath(new URL('../../../assets/fonts/HarmonyOS_Sans_Bold.ttf', import.meta.url));

/** 58 mm thermal paper: 164 pt wide like the bill PDF, rasterised to 768 px for the POS. */
const PAGE_WIDTH = 164;
const MARGIN = 10;

type Money = { toString(): string } | number;

/** Everything printed on a refund slip, taken from the frozen refund and order lines (BR-86). */
export interface RefundPdfSnapshot {
  refundId: string;
  orderCode: string;
  callNumber: number | null;
  paidAt: Date | null;
  currency: string;
  seller: { name: string; branchName: string; address: string; phone: string | null };
  /** How the customer paid originally; the refund itself is always cash (BR-81). */
  paidWith: 'CASH' | 'QR';
  scope: 'PARTIAL' | 'FULL';
  lines: Array<{
    itemName: string;
    quantity: number;
    unitPrice: Money;
    refundAmount: Money;
    lineType?: string;
    selectedOptions: unknown;
    children: Array<{ itemName: string; quantity: number }>;
  }>;
  refundAmount: Money;
  totalCollected: Money;
  totalRefunded: Money;
  reason: string;
  refundedBy: string;
  refundedByRole: string;
  refundedAt: Date;
  approvedBy: string | null;
}

const reasonLabels: Record<string, string> = {
  CHANGE_OF_MIND: 'Khách đổi ý',
  WRONG_ITEM: 'Món sai',
  OUT_OF_STOCK: 'Hết món',
  LONG_WAIT: 'Chờ quá lâu',
  OTHER: 'Khác',
};
const roleLabels: Record<string, string> = { CASHIER: 'Thu ngân', MANAGER: 'Store Manager', OWNER: 'Brand Manager' };

/** "WRONG_ITEM: ghi chú" → "Món sai – ghi chú" (codes from CashierRefundDto / CancelPaidOrderDto). */
export function refundReasonText(reason: string) {
  const [code, ...rest] = reason.split(':');
  const label = reasonLabels[code.trim()];
  if (!label) return reason;
  const note = rest.join(':').trim();
  return note ? `${label} – ${note}` : label;
}

@Injectable()
export class RefundPdfService {
  async render(slip: RefundPdfSnapshot): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const doc = new PDFDocument({
        size: [PAGE_WIDTH, 900],
        margin: MARGIN,
        autoFirstPage: true,
        // Fixed metadata: the bytes depend only on the frozen refund, never on when they were rendered.
        info: { Title: `Phieu hoan ${slip.orderCode}`, Producer: 'Smart F&B', Creator: 'Smart F&B', CreationDate: slip.refundedAt, ModDate: slip.refundedAt },
      });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      doc.registerFont('Noto', regularFont).registerFont('NotoBold', boldFont);
      const time = (value: Date) => value.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });

      doc.font('NotoBold').fontSize(12).text(slip.seller.name, { align: 'center' });
      doc.font('Noto').fontSize(8).text(slip.seller.branchName, { align: 'center' });
      if (slip.seller.address) doc.text(slip.seller.address, { align: 'center' });
      if (slip.seller.phone) doc.text(`ĐT: ${slip.seller.phone}`, { align: 'center' });
      this.rule(doc);
      doc.font('NotoBold').fontSize(11).text('PHIẾU HOÀN TIỀN', { align: 'center' });
      doc.font('Noto').fontSize(8).text(slip.scope === 'FULL' ? 'Hoàn toàn bộ đơn' : 'Hoàn một phần', { align: 'center' });
      doc.moveDown(0.3);
      doc.text(`Mã phiếu: ${slip.refundId.slice(0, 8).toUpperCase()}`);
      doc.text(`Mã đơn: ${slip.orderCode}`);
      if (slip.callNumber !== null) doc.text(`Số gọi: ${String(slip.callNumber).padStart(3, '0')}`);
      if (slip.paidAt) doc.text(`Thanh toán lúc: ${time(slip.paidAt)}`);
      doc.text(`Khách đã trả bằng: ${slip.paidWith === 'QR' ? 'QR (PayOS)' : 'Tiền mặt'}`);
      this.rule(doc);

      doc.font('NotoBold').fontSize(8).text('Dòng được hoàn');
      for (const line of slip.lines) {
        doc.font('NotoBold').fontSize(8).text(`${line.quantity} × ${line.itemName}`);
        doc.font('Noto').text(`${this.money(line.unitPrice)} / phần`, { continued: false });
        if (line.lineType === 'COMBO') {
          for (const child of line.children) doc.fontSize(7).text(`  ${child.quantity} × ${child.itemName}`);
        } else {
          const options = this.optionLabels(line.selectedOptions);
          if (options.length) doc.fontSize(7).text(options.join(', '));
        }
        doc.fontSize(8).text(`Hoàn: ${this.money(line.refundAmount)}`, { align: 'right' });
      }
      this.rule(doc);
      doc.font('NotoBold').fontSize(10).text('TỔNG HOÀN (TIỀN MẶT)', { align: 'center' });
      doc.fontSize(14).text(this.money(slip.refundAmount), { align: 'center' });
      doc.font('Noto').fontSize(8);
      doc.moveDown(0.3);
      doc.text(`Tổng đã thu của đơn: ${this.money(slip.totalCollected)}`);
      doc.text(`Đã hoàn luỹ kế: ${this.money(slip.totalRefunded)}`);
      this.rule(doc);
      doc.text(`Lý do: ${refundReasonText(slip.reason)}`);
      doc.text(`Người hoàn: ${slip.refundedBy} (${roleLabels[slip.refundedByRole] ?? slip.refundedByRole})`);
      if (slip.approvedBy) doc.text(`Người duyệt: ${slip.approvedBy}`);
      doc.text(`Thời điểm: ${time(slip.refundedAt)}`);
      doc.moveDown(0.8);
      doc.text('Khách ký nhận:', { align: 'left' });
      doc.moveDown(1.6);
      doc.text('.....................................', { align: 'center' });
      this.rule(doc);
      doc.fontSize(7).text('Chứng từ nội bộ – không phải hóa đơn điện tử. Hoàn bằng tiền mặt tại quầy; bill gốc giữ nguyên.', { align: 'center' });
      doc.end();
    });
  }

  private rule(doc: PDFKit.PDFDocument) {
    doc.moveDown(0.4).strokeColor('#999').moveTo(MARGIN, doc.y).lineTo(PAGE_WIDTH - MARGIN, doc.y).stroke().moveDown(0.4);
  }

  private money(value: Money) {
    return `${Number(value.toString()).toLocaleString('vi-VN')} ₫`;
  }

  /** Options and toppings as frozen on the order line (same shape the bill PDF prints). */
  private optionLabels(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value
      .map((item) =>
        item && typeof item === 'object' && 'name' in item
          ? 'kind' in item && item.kind === 'EXTRA' && 'quantity' in item
            ? `+${item.quantity} ${item.name}`
            : String(item.name)
          : null,
      )
      .filter((item): item is string => Boolean(item));
  }
}
