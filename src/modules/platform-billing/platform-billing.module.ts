import { Module } from '@nestjs/common';
import { BranchesModule } from '../branches/branches.module.js';
import { EmailModule } from '../email/email.module.js';
import { PayosApiService } from '../payos/payos-api.service.js';
import {
  PlatformBillingAdminController,
  PlatformBillingController,
  PlatformBillingWebhookController,
} from './platform-billing.controller.js';
import { PlatformBillingService } from './platform-billing.service.js';
import { TrialReminderWorker } from './trial-reminder.worker.js';

@Module({
  imports: [BranchesModule, EmailModule],
  controllers: [
    PlatformBillingController,
    PlatformBillingWebhookController,
    PlatformBillingAdminController,
  ],
  providers: [PlatformBillingService, PayosApiService, TrialReminderWorker],
})
export class PlatformBillingModule {}
