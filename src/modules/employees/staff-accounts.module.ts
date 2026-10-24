import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { EmailModule } from '../email/email.module.js';
import { StaffAccountsService } from './staff-accounts.service.js';

@Module({
  imports: [AuthModule, EmailModule],
  providers: [StaffAccountsService],
  exports: [StaffAccountsService],
})
export class StaffAccountsModule {}
