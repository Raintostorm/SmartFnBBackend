import { Module } from '@nestjs/common';
import { SubscriptionModule } from '../subscription/subscription.module.js';
import { BranchesController } from './branches.controller.js';
import { BranchAccessService } from './branch-access.service.js';
import { BranchesService } from './branches.service.js';
import { PublicBranchesController } from './public-branches.controller.js';
import { RestaurantChainsController } from './restaurant-chains.controller.js';
import { ChainSubscriptionController } from './chain-subscription.controller.js';

@Module({
  imports: [SubscriptionModule],
  controllers: [
    RestaurantChainsController,
    ChainSubscriptionController,
    BranchesController,
    PublicBranchesController,
  ],
  providers: [BranchesService, BranchAccessService],
  exports: [BranchesService, BranchAccessService],
})
export class BranchesModule {}
