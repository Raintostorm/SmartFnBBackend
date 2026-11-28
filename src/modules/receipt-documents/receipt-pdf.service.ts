import { Injectable } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { fileURLToPath } from 'node:url';
import type { ReceiptFooter } from '../branch-manager/receipt-settings.js';

// Use the same complete font files as the web app. The old Vietnamese-only
// WOFF subset omitted basic Latin glyphs, which PDF viewers showed as boxes.
const regularFont = fileURLToPath(
  new URL('../../../assets/fonts/HarmonyOS_Sans_Regular.ttf', import.meta.url),
);
const boldFont = fileURLToPath(
  new URL('../../../assets/fonts/HarmonyOS_Sans_Bold.ttf', import.meta.url),
);

export interface ReceiptPdfSnapshot {
  orderCode: string;
  /** Số bàn thu ngân gán trước khi in; in to ở đầu phiếu (thay cho số gọi trước đây). */
  tableNumber: number | null;
  paidAt: Date;
  currency: string;
  seller: { name: string; branchName: string; address: string; phone: string | null };
  cashier: string | null;
  items: Array<{
    itemName: string;
    parentId?: string | null;
    lineType?: string;
    id?: string;
    quantity: number;
    unitPrice: { toString(): string };
    selectedOptions: unknown;
    specialInstructions: string | null;
  }>;
  totalAmount: { toString(): string };
  payment: {
    method: string;
    tenderedAmount: { toString(): string } | null;
    changeAmount: { toString(): string } | null;
  } | null;
  /** Phần Store Manager tuỳ biến ở cuối phiếu (BM-08). */
  footer: ReceiptFooter;
}

@Injectable()
export class ReceiptPdfService {
  async render(receipt: ReceiptPdfSnapshot): Promise<Buffer> {
    const { footer } = receipt;
    const qr = footer.reviewUrl ? await QRCode.toBuffer(footer.reviewUrl, { margin: 1 }) : null;
    return new Promise<Buffer>((resolve, reject) => {
      const doc = new PDFDocument({ size: [164, 800], margin: 10, autoFirstPage: true });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      doc.registerFont('Noto', regularFont).registerFont('NotoBold', boldFont);
      doc.font('NotoBold').fontSize(12).text(receipt.seller.name, { align: 'center' });
      doc.font('Noto').fontSize(8).text(receipt.seller.branchName, { align: 'center' });
      if (receipt.seller.address) doc.text(receipt.seller.address, { align: 'center' });
      if (receipt.seller.phone) doc.text(`ĐT: ${receipt.seller.phone}`, { align: 'center' });
      this.rule(doc);
      doc.font('NotoBold').fontSize(11).text('PHIẾU THANH TOÁN', { align: 'center' });
      if (receipt.tableNumber !== null) {
        doc.font('Noto').fontSize(9).text('SỐ BÀN', { align: 'center' });
        doc.font('NotoBold').fontSize(24).text(String(receipt.tableNumber), { align: 'center' });
        doc.moveDown(0.2);
      }
      doc.font('Noto').fontSize(8).text(`Mã đơn: ${receipt.orderCode}`);
      doc.text(
        `Thời gian: ${receipt.paidAt.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}`,
      );
      if (receipt.cashier) doc.text(`Thu ngân: ${receipt.cashier}`);
      this.rule(doc);
      const displayItems = receipt.items.flatMap((item) =>
        item.parentId
          ? []
          : [
              item,
              ...receipt.items.filter((child) => child.parentId === item.id && child.parentId),
            ],
      );
      for (const item of displayItems) {
        doc
          .font(item.parentId ? 'Noto' : 'NotoBold')
          .text(`${item.parentId ? '  ' : ''}${item.quantity} × ${item.itemName}`);
        if (!item.parentId)
          doc.font('Noto').text(this.money(Number(item.unitPrice.toString()) * item.quantity), {
            align: 'right',
          });
        const options = item.lineType === 'COMBO' ? [] : this.optionLabels(item.selectedOptions);
        if (options.length) doc.fontSize(7).text(options.join(', '));
        if (item.specialInstructions) doc.fontSize(7).text(`Ghi chú: ${item.specialInstructions}`);
        doc.fontSize(8);
      }
      this.rule(doc);
      doc
        .font('NotoBold')
        .fontSize(10)
        .text(`TỔNG: ${this.money(receipt.totalAmount.toString())}`, {
          align: 'right',
        });
      if (receipt.payment) {
        doc.font('Noto').fontSize(8).text(`Thanh toán: ${receipt.payment.method}`);
        if (receipt.payment.tenderedAmount)
          doc.text(`Tiền khách đưa: ${this.money(receipt.payment.tenderedAmount.toString())}`);
        if (receipt.payment.changeAmount)
          doc.text(`Tiền thừa: ${this.money(receipt.payment.changeAmount.toString())}`);
      }
      if (footer.wifiName || footer.wifiPassword) {
        this.rule(doc);
        doc.font('NotoBold').fontSize(8).text('WIFI', { align: 'center' });
        doc.font('Noto');
        if (footer.wifiName) doc.text(`Tên: ${footer.wifiName}`, { align: 'center' });
        if (footer.wifiPassword) doc.text(`Mật khẩu: ${footer.wifiPassword}`, { align: 'center' });
      }
      if (qr) {
        this.rule(doc);
        // `image` không đẩy con trỏ xuống; đặt `y` ngay dưới ảnh thay vì `moveDown` để không chừa khoảng trắng lớn.
        const qrTop = doc.y + 2;
        doc.image(qr, (164 - 70) / 2, qrTop, { width: 70 });
        doc.y = qrTop + 70 + 2;
        doc.font('Noto').fontSize(7).text('Quét mã để đánh giá quán', { align: 'center' });
      }
      this.rule(doc);
      doc.font('Noto').fontSize(7).text('Phiếu thanh toán nội bộ – không phải hóa đơn điện tử.', {
        align: 'center',
      });
      doc.text(footer.note ?? 'Cảm ơn quý khách!', { align: 'center' });
      doc.end();
    });
  }

  private rule(doc: PDFKit.PDFDocument) {
    doc
      .moveDown(0.4)
      .strokeColor('#999')
      .moveTo(10, doc.y)
      .lineTo(154, doc.y)
      .stroke()
      .moveDown(0.4);
  }

  private money(value: string | number) {
    return `${Number(value).toLocaleString('vi-VN')} ₫`;
  }

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
