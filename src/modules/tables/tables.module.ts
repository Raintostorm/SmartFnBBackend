import { Module } from '@nestjs/common';
import { BranchesModule } from '../branches/branches.module.js';
import { TablesController } from './tables.controller.js';
import { TablesService } from './tables.service.js';
import { RealtimeModule } from '../../realtime/realtime.module.js';

@Module({
  imports: [BranchesModule, RealtimeModule],
  controllers: [TablesController],
  providers: [TablesService],
})
export class TablesModule {}
