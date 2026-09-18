import { Module } from '@nestjs/common';
import { PlanQuotaService } from './plan-quota.service.js';

@Module({
  providers: [PlanQuotaService],
  exports: [PlanQuotaService],
})
export class SubscriptionModule {}
