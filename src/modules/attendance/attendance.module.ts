import { Module } from '@nestjs/common';
import { BranchesModule } from '../branches/branches.module.js';
import { AttendanceController } from './attendance.controller.js';
import { AttendanceService } from './attendance.service.js';
import { RealtimeModule } from '../../realtime/realtime.module.js';

@Module({
  imports: [BranchesModule, RealtimeModule],
  controllers: [AttendanceController],
  providers: [AttendanceService],
  exports: [AttendanceService],
})
export class AttendanceModule {}
