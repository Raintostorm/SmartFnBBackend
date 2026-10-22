import { Injectable } from '@nestjs/common';
import { createCanvas, type Canvas, type SKRSContext2D } from '@napi-rs/canvas';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

/**
 * Máy in nhiệt 58mm có 384 điểm ngang. Render gấp đôi (768px) để Mobile thu nhỏ theo trung bình vùng, chữ mịn hơn
 * so với render thẳng ở 384px (cùng tỷ lệ với `CAPTURE_SCALE` phía app).
 */
export const RECEIPT_RASTER_WIDTH_PX = 768;
/** Chừa lại một lề nhỏ dưới nội dung cuối; phần trắng còn lại của trang PDF cao cố định bị cắt bỏ. */
const BOTTOM_PADDING_PX = 48;
/** Điểm có mọi kênh màu từ mức này trở lên được coi là nền trắng khi cắt phần trống cuối phiếu. */
const WHITE_THRESHOLD = 250;
/** Phiếu hợp lệ chỉ vài trang; giới hạn để một file bất thường không chiếm hết bộ nhớ. */
const MAX_PAGES = 6;

/**
 * Chuyển PDF phiếu thanh toán đã lưu thành một ảnh PNG liền mạch để Mobile đưa thẳng vào đường in ảnh ESC/POS.
 * Ảnh sinh từ chính byte PDF đã lưu nên giống hệt bản lưu trữ, không dựng lại nội dung từ dữ liệu đơn.
 */
@Injectable()
export class ReceiptRasterService {
  async render(pdf: Buffer): Promise<Buffer> {
    const loading = getDocument({
      data: new Uint8Array(pdf),
      useSystemFonts: false,
      verbosity: 0,
    });
    const document = await loading.promise;
    try {
      const pages: Canvas[] = [];
      const count = Math.min(document.numPages, MAX_PAGES);
      for (let number = 1; number <= count; number += 1) {
        const page = await document.getPage(number);
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: RECEIPT_RASTER_WIDTH_PX / base.width });
        const canvas = createCanvas(RECEIPT_RASTER_WIDTH_PX, Math.ceil(viewport.height));
        const context = canvas.getContext('2d');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        // pdfjs v6 vẽ qua `canvas`; @napi-rs/canvas tương thích giao diện 2D nhưng không phải kiểu DOM.
        await page.render({ canvas: canvas as unknown as HTMLCanvasElement, viewport }).promise;
        page.cleanup();
        pages.push(canvas);
      }
      return this.stitchAndTrim(pages);
    } finally {
      await loading.destroy();
    }
  }

  private stitchAndTrim(pages: Canvas[]): Buffer {
    const totalHeight = pages.reduce((sum, page) => sum + page.height, 0);
    const stitched = createCanvas(RECEIPT_RASTER_WIDTH_PX, totalHeight);
    const context = stitched.getContext('2d');
    let top = 0;
    for (const page of pages) {
      context.drawImage(page, 0, top);
      top += page.height;
    }
    const height = Math.min(
      totalHeight,
      this.lastInkRow(context, RECEIPT_RASTER_WIDTH_PX, totalHeight) + 1 + BOTTOM_PADDING_PX,
    );
    const trimmed = createCanvas(RECEIPT_RASTER_WIDTH_PX, height);
    trimmed.getContext('2d').drawImage(stitched, 0, 0);
    return trimmed.toBuffer('image/png');
  }

  /** Dòng cuối cùng có điểm không trắng; không có điểm nào thì giữ nguyên toàn bộ ảnh. */
  private lastInkRow(context: SKRSContext2D, width: number, height: number): number {
    const { data } = context.getImageData(0, 0, width, height);
    for (let y = height - 1; y >= 0; y -= 1) {
      const rowStart = y * width * 4;
      for (let x = 0; x < width; x += 1) {
        const i = rowStart + x * 4;
        if (
          data[i] < WHITE_THRESHOLD ||
          data[i + 1] < WHITE_THRESHOLD ||
          data[i + 2] < WHITE_THRESHOLD
        ) {
          return y;
        }
      }
    }
    return height - 1;
  }
}
