import { Module } from '@nestjs/common';
import { PlanQuotaService } from './plan-quota.service.js';
import { SubscriptionScheduleService } from './subscription-schedule.service.js';
import { PayosApiService } from '../payos/payos-api.service.js';

@Module({
  providers: [PlanQuotaService, SubscriptionScheduleService, PayosApiService],
  exports: [PlanQuotaService, SubscriptionScheduleService],
})
export class SubscriptionModule {}
