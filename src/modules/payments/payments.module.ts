import {
  CashierRefundApprovalsController,
  CashierRefundsController,
} from './cashier-refunds.controller.js';
import { Module } from '@nestjs/common';
import { BranchesModule } from '../branches/branches.module.js';
import { PaymentsController } from './payments.controller.js';
import { PaymentsService } from './payments.service.js';
import { RealtimeModule } from '../../realtime/realtime.module.js';
import { OrderTrackingModule } from '../order-tracking/order-tracking.module.js';
import { CounterPaymentSettlementService } from './counter-payment-settlement.service.js';
import { PaidOrderRefundService } from './paid-order-refund.service.js';
import { ReceiptDocumentsModule } from '../receipt-documents/receipt-documents.module.js';
import { CashLedgerModule } from './cash-ledger.module.js';

@Module({
  imports: [
    BranchesModule,
    RealtimeModule,
    OrderTrackingModule,
    ReceiptDocumentsModule,
    CashLedgerModule,
  ],
  controllers: [PaymentsController, CashierRefundsController, CashierRefundApprovalsController],
  providers: [PaymentsService, CounterPaymentSettlementService, PaidOrderRefundService],
  exports: [CounterPaymentSettlementService, PaidOrderRefundService],
})
export class PaymentsModule {}
