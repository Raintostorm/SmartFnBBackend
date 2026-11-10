import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { EmailModule } from '../email/email.module.js';
import { PlatformAdminController } from './platform-admin.controller.js';
import { PlatformAdminService } from './platform-admin.service.js';
import { PlatformStaffController } from './platform-staff.controller.js';
import { PlatformStaffAccountsController } from './platform-staff-accounts.controller.js';
import { PlatformStaffAccountsService } from './platform-staff-accounts.service.js';
import { PayosApiService } from '../payos/payos-api.service.js';
import { PublicServicePlansController } from './public-service-plans.controller.js';
import { RegistrationApplicationsController } from './registration-applications.controller.js';
import { SubscriptionModule } from '../subscription/subscription.module.js';

@Module({
  imports: [AuthModule, EmailModule, SubscriptionModule],
  controllers: [
    RegistrationApplicationsController,
    PublicServicePlansController,
    PlatformAdminController,
    PlatformStaffController,
    PlatformStaffAccountsController,
  ],
  providers: [PlatformAdminService, PlatformStaffAccountsService, PayosApiService],
  exports: [PlatformAdminService],
})
export class PlatformAdminModule {}
