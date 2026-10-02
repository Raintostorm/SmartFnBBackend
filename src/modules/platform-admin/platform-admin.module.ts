import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { PlatformAdminController } from './platform-admin.controller.js';
import { PlatformAdminService } from './platform-admin.service.js';
import { PublicServicePlansController } from './public-service-plans.controller.js';
import { RegistrationApplicationsController } from './registration-applications.controller.js';

@Module({
  imports: [AuthModule],
  controllers: [
    RegistrationApplicationsController,
    PublicServicePlansController,
    PlatformAdminController,
  ],
  providers: [PlatformAdminService],
})
export class PlatformAdminModule {}
