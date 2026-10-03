import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { BranchesModule } from '../branches/branches.module.js';
import { RealtimeModule } from '../../realtime/realtime.module.js';
import { BranchManagerController } from './branch-manager.controller.js';
import { ManagerStaffService } from './manager-staff.service.js';
import { ManagerOperationsService } from './manager-operations.service.js';
import { ManagerReportsService } from './manager-reports.service.js';

@Module({
  imports: [AuthModule, BranchesModule, RealtimeModule],
  controllers: [BranchManagerController],
  providers: [ManagerStaffService, ManagerOperationsService, ManagerReportsService],
})
export class BranchManagerModule {}
