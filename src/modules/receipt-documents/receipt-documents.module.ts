import { Module } from '@nestjs/common';
import { BranchesModule } from '../branches/branches.module.js';
import { OrderTrackingModule } from '../order-tracking/order-tracking.module.js';
import { ReceiptDocumentsController } from './receipt-documents.controller.js';
import { ReceiptDocumentsService } from './receipt-documents.service.js';
import { ReceiptPdfService } from './receipt-pdf.service.js';
import { ReceiptRasterService } from './receipt-raster.service.js';
import { ReceiptStorageService } from './receipt-storage.service.js';
import { RefundDocumentsController, RefundPrintLogsController } from './refund-documents.controller.js';
import { RefundDocumentsService } from './refund-documents.service.js';
import { RefundPdfService } from './refund-pdf.service.js';

@Module({
  imports: [BranchesModule, OrderTrackingModule],
  controllers: [ReceiptDocumentsController, RefundDocumentsController, RefundPrintLogsController],
  providers: [
    ReceiptDocumentsService,
    ReceiptPdfService,
    ReceiptRasterService,
    ReceiptStorageService,
    RefundDocumentsService,
    RefundPdfService,
  ],
  exports: [ReceiptDocumentsService, RefundDocumentsService],
})
export class ReceiptDocumentsModule {}
