import { Injectable } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const regularFont =
  require.resolve('@fontsource/noto-sans/files/noto-sans-vietnamese-400-normal.woff');
const boldFont =
  require.resolve('@fontsource/noto-sans/files/noto-sans-vietnamese-700-normal.woff');

export interface ReceiptPdfSnapshot {
  orderCode: string;
  callNumber: number | null;
  paidAt: Date;
  currency: string;
  seller: { name: string; branchName: string; address: string; phone: string | null };
  cashier: string | null;
  items: Array<{
    itemName: string;
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
  trackingUrl: string | null;
}

@Injectable()
export class ReceiptPdfService {
  async render(receipt: ReceiptPdfSnapshot): Promise<Buffer> {
    const qr = receipt.trackingUrl
      ? await QRCode.toBuffer(receipt.trackingUrl, { margin: 1 })
      : null;
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
      doc.font('Noto').fontSize(8).text(`Mã đơn: ${receipt.orderCode}`);
      doc.text(
        `Thời gian: ${receipt.paidAt.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}`,
      );
      if (receipt.cashier) doc.text(`Thu ngân: ${receipt.cashier}`);
      this.rule(doc);
      for (const item of receipt.items) {
        doc.font('NotoBold').text(`${item.quantity} × ${item.itemName}`);
        doc.font('Noto').text(this.money(Number(item.unitPrice.toString()) * item.quantity), {
          align: 'right',
        });
        const options = this.optionLabels(item.selectedOptions);
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
      if (receipt.callNumber !== null) {
        this.rule(doc);
        doc.font('Noto').fontSize(9).text('SỐ GỌI', { align: 'center' });
        doc.font('NotoBold').fontSize(24).text(String(receipt.callNumber).padStart(3, '0'), {
          align: 'center',
        });
      }
      if (qr) {
        doc.image(qr, (164 - 70) / 2, doc.y + 4, { width: 70 });
        doc
          .moveDown(10)
          .font('Noto')
          .fontSize(7)
          .text('Quét mã để theo dõi đơn', { align: 'center' });
      }
      this.rule(doc);
      doc.font('Noto').fontSize(7).text('Phiếu thanh toán nội bộ – không phải hóa đơn điện tử.', {
        align: 'center',
      });
      doc.text('Cảm ơn quý khách!', { align: 'center' });
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
        item && typeof item === 'object' && 'name' in item ? String(item.name) : null,
      )
      .filter((item): item is string => Boolean(item));
  }
}
