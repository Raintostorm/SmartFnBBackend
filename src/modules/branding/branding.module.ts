import { Module } from '@nestjs/common';
import { BranchesModule } from '../branches/branches.module.js';
import { BrandingController } from './branding.controller.js';
import { BrandingService } from './branding.service.js';
import { RealtimeModule } from '../../realtime/realtime.module.js';

@Module({
  imports: [BranchesModule, RealtimeModule],
  controllers: [BrandingController],
  providers: [BrandingService],
  exports: [BrandingService],
})
export class BrandingModule {}
