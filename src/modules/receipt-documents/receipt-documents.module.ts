import { Module } from '@nestjs/common';
import { BranchesModule } from '../branches/branches.module.js';
import { OrderTrackingModule } from '../order-tracking/order-tracking.module.js';
import { ReceiptDocumentsController } from './receipt-documents.controller.js';
import { ReceiptDocumentsService } from './receipt-documents.service.js';
import { ReceiptPdfService } from './receipt-pdf.service.js';
import { ReceiptStorageService } from './receipt-storage.service.js';

@Module({
  imports: [BranchesModule, OrderTrackingModule],
  controllers: [ReceiptDocumentsController],
  providers: [ReceiptDocumentsService, ReceiptPdfService, ReceiptStorageService],
  exports: [ReceiptDocumentsService],
})
export class ReceiptDocumentsModule {}
