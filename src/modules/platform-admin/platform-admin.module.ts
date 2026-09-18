import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { OwnerFinanceController } from './owner-finance.controller.js';
import { PlatformAdminController } from './platform-admin.controller.js';
import { PlatformAdminService } from './platform-admin.service.js';
import { PlatformFinanceService } from './platform-finance.service.js';
import { RegistrationApplicationsController } from './registration-applications.controller.js';

@Module({
  imports: [AuthModule],
  controllers: [
    RegistrationApplicationsController,
    PlatformAdminController,
    OwnerFinanceController,
  ],
  providers: [PlatformAdminService, PlatformFinanceService],
})
export class PlatformAdminModule {}
