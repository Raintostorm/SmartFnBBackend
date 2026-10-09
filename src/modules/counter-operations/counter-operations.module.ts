import { Module } from '@nestjs/common';
import { RealtimeModule } from '../../realtime/realtime.module.js';
import { BranchesModule } from '../branches/branches.module.js';
import { BaristaController, CashierController } from './counter-operations.controller.js';
import { CounterOperationsService } from './counter-operations.service.js';
import { StationsController } from './stations.controller.js';
import { StationsService } from './stations.service.js';
import { PayosModule } from '../payos/payos.module.js';
import { OrderTrackingModule } from '../order-tracking/order-tracking.module.js';

@Module({
  imports: [RealtimeModule, BranchesModule, PayosModule, OrderTrackingModule],
  controllers: [CashierController, BaristaController, StationsController],
  providers: [CounterOperationsService, StationsService],
  exports: [CounterOperationsService],
})
export class CounterOperationsModule {}
