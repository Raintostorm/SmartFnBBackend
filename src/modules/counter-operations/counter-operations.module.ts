import { Module } from '@nestjs/common';
import { RealtimeModule } from '../../realtime/realtime.module.js';
import { BaristaController, CashierController } from './counter-operations.controller.js';
import { CounterOperationsService } from './counter-operations.service.js';
import { StationsController } from './stations.controller.js';
import { StationsService } from './stations.service.js';

@Module({
  imports: [RealtimeModule],
  controllers: [CashierController, BaristaController, StationsController],
  providers: [CounterOperationsService, StationsService],
  exports: [CounterOperationsService],
})
export class CounterOperationsModule {}
