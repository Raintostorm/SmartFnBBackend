import { Module } from '@nestjs/common';
import { BranchesModule } from '../branches/branches.module.js';
import { ReportsController } from './reports.controller.js';
import { ReportsService } from './reports.service.js';
import { SubscriptionModule } from '../subscription/subscription.module.js';

@Module({
  imports: [BranchesModule, SubscriptionModule],
  controllers: [ReportsController],
  providers: [ReportsService],
  exports: [ReportsService],
})
export class ReportsModule {}
