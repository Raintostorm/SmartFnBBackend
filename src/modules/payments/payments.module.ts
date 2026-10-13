import { Module } from '@nestjs/common';
import { BranchesModule } from '../branches/branches.module.js';
import { PaymentsController } from './payments.controller.js';
import { PaymentsService } from './payments.service.js';
import { RealtimeModule } from '../../realtime/realtime.module.js';
import { OrderTrackingModule } from '../order-tracking/order-tracking.module.js';
import { CounterPaymentSettlementService } from './counter-payment-settlement.service.js';
import { PaidOrderRefundService } from './paid-order-refund.service.js';
import { PaymentExpiryWorker } from './payment-expiry.worker.js';

@Module({
  imports: [BranchesModule, RealtimeModule, OrderTrackingModule],
  controllers: [PaymentsController],
  providers: [
    PaymentsService,
    CounterPaymentSettlementService,
    PaidOrderRefundService,
    PaymentExpiryWorker,
  ],
  exports: [CounterPaymentSettlementService, PaidOrderRefundService],
})
export class PaymentsModule {}
