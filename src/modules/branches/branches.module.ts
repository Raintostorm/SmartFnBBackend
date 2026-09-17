import { Module } from '@nestjs/common';
import { BranchesController } from './branches.controller.js';
import { BranchAccessService } from './branch-access.service.js';
import { BranchesService } from './branches.service.js';
import { OwnerAssignmentsController } from './owner-assignments.controller.js';
import { OwnerAssignmentsService } from './owner-assignments.service.js';
import { PublicBranchesController } from './public-branches.controller.js';
import { RestaurantChainsController } from './restaurant-chains.controller.js';

@Module({
  controllers: [
    RestaurantChainsController,
    BranchesController,
    OwnerAssignmentsController,
    PublicBranchesController,
  ],
  providers: [BranchesService, BranchAccessService, OwnerAssignmentsService],
  exports: [BranchesService, BranchAccessService],
})
export class BranchesModule {}
