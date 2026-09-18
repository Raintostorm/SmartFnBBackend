import { Body, Controller, Get, Param, ParseUUIDPipe, Patch } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AppRole } from '../auth/app-role.enum.js';
import { SWAGGER_ACCESS_TOKEN } from '../auth/auth.constants.js';
import type { AuthenticatedUser } from '../auth/auth.interfaces.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { UpdateBranchMenuItemDto } from './dto/menu.dto.js';
import { MenuService } from './menu.service.js';

@ApiTags('Menu - branch')
@ApiBearerAuth(SWAGGER_ACCESS_TOKEN)
@ApiUnauthorizedResponse({ description: 'Access token is missing, invalid, or expired' })
@ApiForbiddenResponse({ description: 'The branch is outside your assigned scope' })
@ApiParam({ name: 'branchId', format: 'uuid' })
@Controller('branches/:branchId/menu')
export class BranchMenuController {
  constructor(private readonly menuService: MenuService) {}

  @Roles(AppRole.OWNER, AppRole.MANAGER, AppRole.WAITER, AppRole.KITCHEN, AppRole.CASHIER)
  @Get()
  @ApiOperation({
    summary: 'The menu as this branch sells it',
    description:
      'Chain categories and items, filtered down to what is switched on both chain wide and ' +
      'for this branch.',
  })
  @ApiOkResponse({ description: 'Branch menu' })
  @ApiNotFoundResponse({ description: 'Branch not found' })
  getBranchMenu(
    @Param('branchId', new ParseUUIDPipe()) branchId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menuService.getBranchMenu(branchId, user);
  }

  @Roles(AppRole.OWNER, AppRole.MANAGER)
  @Patch('items/:itemId')
  @ApiOperation({
    summary: 'Change how one branch carries a chain item',
    description:
      'isEnabled decides whether the branch carries the item at all; isAvailable and ' +
      'remainingPortions cover running out during service.',
  })
  @ApiParam({ name: 'itemId', format: 'uuid' })
  @ApiOkResponse({ description: 'Branch availability saved' })
  @ApiBadRequestResponse({ description: 'No field to update was provided' })
  @ApiNotFoundResponse({ description: 'Branch or menu item not found' })
  updateBranchMenuItem(
    @Param('branchId', new ParseUUIDPipe()) branchId: string,
    @Param('itemId', new ParseUUIDPipe()) itemId: string,
    @Body() dto: UpdateBranchMenuItemDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menuService.updateBranchMenuItem(branchId, itemId, dto, user);
  }
}
