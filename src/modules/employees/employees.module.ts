import { Module } from '@nestjs/common';
import { BranchesModule } from '../branches/branches.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { EmployeesController } from './employees.controller.js';
import { EmployeesService } from './employees.service.js';
import { StaffAccountsModule } from './staff-accounts.module.js';

@Module({
  imports: [BranchesModule, AuthModule, StaffAccountsModule],
  controllers: [EmployeesController],
  providers: [EmployeesService],
  exports: [EmployeesService],
})
export class EmployeesModule {}
