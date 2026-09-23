import { Module } from '@nestjs/common';
import { BranchesModule } from '../branches/branches.module.js';
import { PaymentsController } from './payments.controller.js';
import { PaymentsService } from './payments.service.js';
import { RealtimeModule } from '../../realtime/realtime.module.js';

@Module({
  imports: [BranchesModule, RealtimeModule],
  controllers: [PaymentsController],
  providers: [PaymentsService],
})
export class PaymentsModule {}
