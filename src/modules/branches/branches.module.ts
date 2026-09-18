import { Module } from '@nestjs/common';
import { BranchesController } from './branches.controller.js';
import { BranchAccessService } from './branch-access.service.js';
import { BranchesService } from './branches.service.js';
import { PublicBranchesController } from './public-branches.controller.js';
import { RestaurantChainsController } from './restaurant-chains.controller.js';

@Module({
  controllers: [RestaurantChainsController, BranchesController, PublicBranchesController],
  providers: [BranchesService, BranchAccessService],
  exports: [BranchesService, BranchAccessService],
})
export class BranchesModule {}
