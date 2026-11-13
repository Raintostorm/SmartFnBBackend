import { MenuModule } from '../menu/menu.module.js';
import { PagersService } from './pagers.service.js';
import { PagersController } from './pagers.controller.js';
import { Module } from '@nestjs/common';
import { RealtimeModule } from '../../realtime/realtime.module.js';
import { BranchesModule } from '../branches/branches.module.js';
import { BaristaController, CashierController } from './counter-operations.controller.js';
import { CounterOperationsService } from './counter-operations.service.js';
import { StationsController } from './stations.controller.js';
import { StationsService } from './stations.service.js';
import { PayosModule } from '../payos/payos.module.js';
import { OrderTrackingModule } from '../order-tracking/order-tracking.module.js';
import { ReceiptDocumentsModule } from '../receipt-documents/receipt-documents.module.js';
import { CashLedgerModule } from '../payments/cash-ledger.module.js';

@Module({
  imports: [
    MenuModule,
    RealtimeModule,
    BranchesModule,
    PayosModule,
    OrderTrackingModule,
    ReceiptDocumentsModule,
    CashLedgerModule,
  ],
  controllers: [PagersController, CashierController, BaristaController, StationsController],
  providers: [PagersService, CounterOperationsService, StationsService],
  exports: [CounterOperationsService],
})
export class CounterOperationsModule {}
