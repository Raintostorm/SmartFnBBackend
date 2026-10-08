import { Module } from '@nestjs/common';
import { OrderTrackingController } from './order-tracking.controller.js';
import { OrderTrackingService } from './order-tracking.service.js';

@Module({
  controllers: [OrderTrackingController],
  providers: [OrderTrackingService],
  exports: [OrderTrackingService],
})
export class OrderTrackingModule {}
