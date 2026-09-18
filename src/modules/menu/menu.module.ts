import { Module } from '@nestjs/common';
import { BranchesModule } from '../branches/branches.module.js';
import { BranchMenuController } from './branch-menu.controller.js';
import { ChainMenuController } from './chain-menu.controller.js';
import { MenuService } from './menu.service.js';

@Module({
  imports: [BranchesModule],
  controllers: [ChainMenuController, BranchMenuController],
  providers: [MenuService],
  exports: [MenuService],
})
export class MenuModule {}
