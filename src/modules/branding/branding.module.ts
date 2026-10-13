import { Module } from '@nestjs/common';
import { BranchesModule } from '../branches/branches.module.js';
import { BrandingController } from './branding.controller.js';
import { BrandingService } from './branding.service.js';
import { RealtimeModule } from '../../realtime/realtime.module.js';
import { DisplayPostersController } from './display-posters.controller.js';
import { DisplayPostersService } from './display-posters.service.js';

@Module({
  imports: [BranchesModule, RealtimeModule],
  controllers: [BrandingController, DisplayPostersController],
  providers: [BrandingService, DisplayPostersService],
  exports: [BrandingService],
})
export class BrandingModule {}
