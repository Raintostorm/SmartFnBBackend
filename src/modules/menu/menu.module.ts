import { BranchPricesController, BranchPricesService } from './branch-prices.js';
import { CombosService } from './combos.service.js';
import { CombosController, ComboAvailabilityController } from './combos.controller.js';
import { MenuExtrasController, ExtraAvailabilityController } from './menu-extras.controller.js';
import { MenuExtrasService } from './menu-extras.service.js';
import { RealtimeModule } from '../../realtime/realtime.module.js';
import { Module } from '@nestjs/common';
import { BranchesModule } from '../branches/branches.module.js';
import { BranchMenuController } from './branch-menu.controller.js';
import { ChainMenuController } from './chain-menu.controller.js';
import { MenuService } from './menu.service.js';
import { MenuImportsController } from './menu-imports.controller.js';
import { MenuImportsService } from './menu-imports.service.js';

@Module({
  imports: [BranchesModule, RealtimeModule],
  controllers: [
    BranchPricesController,
    CombosController,
    ComboAvailabilityController,
    ChainMenuController,
    BranchMenuController,
    MenuExtrasController,
    ExtraAvailabilityController,
    MenuImportsController,
  ],
  providers: [BranchPricesService, CombosService, MenuService, MenuExtrasService, MenuImportsService],
  exports: [MenuService, CombosService],
})
export class MenuModule {}
