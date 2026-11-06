import { Module } from '@nestjs/common';
import { BranchesModule } from '../branches/branches.module.js';
import { EmailModule } from '../email/email.module.js';
import { PlatformAdminModule } from '../platform-admin/platform-admin.module.js';
import { PayosApiService } from '../payos/payos-api.service.js';
import {
  PlatformBillingAdminController,
  PlatformBillingController,
  PlatformBillingWebhookController,
  PlatformBillingStaffController,
} from './platform-billing.controller.js';
import { PlatformBillingService } from './platform-billing.service.js';
import { TrialReminderWorker } from './trial-reminder.worker.js';
import { PlatformAdminAnalyticsController } from './platform-admin-analytics.controller.js';
import { PlatformAdminAnalyticsService } from './platform-admin-analytics.service.js';

@Module({
  imports: [BranchesModule, EmailModule, PlatformAdminModule],
  controllers: [
    PlatformBillingController,
    PlatformBillingWebhookController,
    PlatformBillingAdminController,
    PlatformAdminAnalyticsController,
    PlatformBillingStaffController,
  ],
  providers: [
    PlatformBillingService,
    PlatformAdminAnalyticsService,
    PayosApiService,
    TrialReminderWorker,
  ],
})
export class PlatformBillingModule {}
