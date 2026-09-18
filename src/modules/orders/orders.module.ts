import { Module } from '@nestjs/common';
import {
  KitchenController,
  ServingTasksController,
  WaiterOrdersController,
} from './orders.controller.js';
import { OrdersService } from './orders.service.js';

@Module({
  controllers: [WaiterOrdersController, KitchenController, ServingTasksController],
  providers: [OrdersService],
})
export class OrdersModule {}
