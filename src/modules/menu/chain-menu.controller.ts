import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
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
import {
  CreateMenuCategoryDto,
  CreateMenuItemDto,
  CreateMenuOptionDto,
  CreateMenuOptionGroupDto,
  ListMenuItemsQueryDto,
  SetMenuItemActiveDto,
  SetMenuItemBranchesDto,
  SetMenuItemOptionGroupsDto,
  UpdateMenuCategoryDto,
  UpdateMenuItemDto,
  UpdateMenuOptionDto,
  UpdateMenuOptionGroupDto,
} from './dto/menu.dto.js';
import { MenuService } from './menu.service.js';

@Roles(AppRole.OWNER)
@ApiTags('Menu - chain wide (OWNER)')
@ApiBearerAuth(SWAGGER_ACCESS_TOKEN)
@ApiUnauthorizedResponse({ description: 'Access token is missing, invalid, or expired' })
@ApiForbiddenResponse({ description: 'Only an assigned OWNER can manage the chain menu' })
@ApiParam({ name: 'chainId', format: 'uuid' })
@Controller('restaurant-chains/:chainId/menu')
export class ChainMenuController {
  constructor(private readonly menuService: MenuService) {}

  // --- Categories -----------------------------------------------------------

  @Get('categories')
  @ApiOperation({ summary: 'List the menu categories of the chain' })
  @ApiOkResponse({ description: 'Menu categories with their item counts' })
  listCategories(
    @Param('chainId', new ParseUUIDPipe()) chainId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menuService.listCategories(chainId, user);
  }

  @Post('categories')
  @ApiOperation({ summary: 'Create a menu category for the whole chain' })
  @ApiCreatedResponse({ description: 'Menu category created' })
  @ApiConflictResponse({ description: 'A category with this name already exists in the chain' })
  createCategory(
    @Param('chainId', new ParseUUIDPipe()) chainId: string,
    @Body() dto: CreateMenuCategoryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menuService.createCategory(chainId, dto, user);
  }

  @Patch('categories/:categoryId')
  @ApiOperation({ summary: 'Rename, reorder, or hide a menu category' })
  @ApiParam({ name: 'categoryId', format: 'uuid' })
  @ApiOkResponse({ description: 'Menu category updated' })
  @ApiNotFoundResponse({ description: 'Menu category not found in this chain' })
  updateCategory(
    @Param('chainId', new ParseUUIDPipe()) chainId: string,
    @Param('categoryId', new ParseUUIDPipe()) categoryId: string,
    @Body() dto: UpdateMenuCategoryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menuService.updateCategory(chainId, categoryId, dto, user);
  }

  @Delete('categories/:categoryId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete an empty menu category' })
  @ApiParam({ name: 'categoryId', format: 'uuid' })
  @ApiOkResponse({ description: 'Menu category deleted' })
  @ApiConflictResponse({ description: 'The category still holds menu items' })
  @ApiNotFoundResponse({ description: 'Menu category not found in this chain' })
  deleteCategory(
    @Param('chainId', new ParseUUIDPipe()) chainId: string,
    @Param('categoryId', new ParseUUIDPipe()) categoryId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menuService.deleteCategory(chainId, categoryId, user);
  }

  // --- Option groups and options ------------------------------------------

  @Get('option-groups')
  @ApiOperation({ summary: 'List chain-wide option groups and their options' })
  @ApiOkResponse({ description: 'Option groups with selection rules and chain-wide prices' })
  listOptionGroups(
    @Param('chainId', new ParseUUIDPipe()) chainId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menuService.listOptionGroups(chainId, user);
  }

  @Post('option-groups')
  @ApiOperation({ summary: 'Create a chain-wide option group' })
  @ApiCreatedResponse({ description: 'Option group created' })
  @ApiBadRequestResponse({ description: 'Selection rules are inconsistent' })
  @ApiConflictResponse({ description: 'An option group with this code already exists' })
  createOptionGroup(
    @Param('chainId', new ParseUUIDPipe()) chainId: string,
    @Body() dto: CreateMenuOptionGroupDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menuService.createOptionGroup(chainId, dto, user);
  }

  @Patch('option-groups/:groupId')
  @ApiOperation({ summary: 'Update selection rules or switch an option group chain-wide' })
  @ApiParam({ name: 'groupId', format: 'uuid' })
  @ApiOkResponse({ description: 'Option group updated' })
  @ApiBadRequestResponse({ description: 'Selection rules are inconsistent' })
  @ApiConflictResponse({ description: 'An option group with this code already exists' })
  @ApiNotFoundResponse({ description: 'Option group not found in this chain' })
  updateOptionGroup(
    @Param('chainId', new ParseUUIDPipe()) chainId: string,
    @Param('groupId', new ParseUUIDPipe()) groupId: string,
    @Body() dto: UpdateMenuOptionGroupDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menuService.updateOptionGroup(chainId, groupId, dto, user);
  }

  @Delete('option-groups/:groupId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete an option group and detach it from every menu item' })
  @ApiParam({ name: 'groupId', format: 'uuid' })
  @ApiOkResponse({ description: 'Option group deleted' })
  @ApiNotFoundResponse({ description: 'Option group not found in this chain' })
  deleteOptionGroup(
    @Param('chainId', new ParseUUIDPipe()) chainId: string,
    @Param('groupId', new ParseUUIDPipe()) groupId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menuService.deleteOptionGroup(chainId, groupId, user);
  }

  @Post('option-groups/:groupId/options')
  @ApiOperation({ summary: 'Create an option with one chain-wide additional price' })
  @ApiParam({ name: 'groupId', format: 'uuid' })
  @ApiCreatedResponse({ description: 'Option created' })
  @ApiConflictResponse({ description: 'An option with this code already exists in the group' })
  @ApiNotFoundResponse({ description: 'Option group not found in this chain' })
  createOption(
    @Param('chainId', new ParseUUIDPipe()) chainId: string,
    @Param('groupId', new ParseUUIDPipe()) groupId: string,
    @Body() dto: CreateMenuOptionDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menuService.createOption(chainId, groupId, dto, user);
  }

  @Patch('option-groups/:groupId/options/:optionId')
  @ApiOperation({ summary: 'Update an option, its price, or its chain-wide active state' })
  @ApiParam({ name: 'groupId', format: 'uuid' })
  @ApiParam({ name: 'optionId', format: 'uuid' })
  @ApiOkResponse({ description: 'Option updated' })
  @ApiConflictResponse({ description: 'An option with this code already exists in the group' })
  @ApiNotFoundResponse({ description: 'Option not found in this chain and group' })
  updateOption(
    @Param('chainId', new ParseUUIDPipe()) chainId: string,
    @Param('groupId', new ParseUUIDPipe()) groupId: string,
    @Param('optionId', new ParseUUIDPipe()) optionId: string,
    @Body() dto: UpdateMenuOptionDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menuService.updateOption(chainId, groupId, optionId, dto, user);
  }

  @Delete('option-groups/:groupId/options/:optionId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete an option from a chain-wide option group' })
  @ApiParam({ name: 'groupId', format: 'uuid' })
  @ApiParam({ name: 'optionId', format: 'uuid' })
  @ApiOkResponse({ description: 'Option deleted' })
  @ApiNotFoundResponse({ description: 'Option not found in this chain and group' })
  deleteOption(
    @Param('chainId', new ParseUUIDPipe()) chainId: string,
    @Param('groupId', new ParseUUIDPipe()) groupId: string,
    @Param('optionId', new ParseUUIDPipe()) optionId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menuService.deleteOption(chainId, groupId, optionId, user);
  }

  // --- Items ----------------------------------------------------------------

  @Get('items')
  @ApiOperation({
    summary: 'List the chain menu items',
    description: 'Each item carries the per-branch availability rows behind it.',
  })
  @ApiOkResponse({ description: 'Menu items with per-branch availability' })
  listItems(
    @Param('chainId', new ParseUUIDPipe()) chainId: string,
    @Query() query: ListMenuItemsQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menuService.listItems(chainId, query, user);
  }

  @Post('items')
  @ApiOperation({
    summary: 'Create a menu item for the chain',
    description:
      'The price is chain wide. Pass branchIds to limit where it is sold; omit it to enable ' +
      'the item at every branch.',
  })
  @ApiCreatedResponse({ description: 'Menu item created' })
  @ApiBadRequestResponse({ description: 'A branch id does not belong to this chain' })
  @ApiConflictResponse({ description: 'A menu item with this SKU already exists' })
  @ApiNotFoundResponse({ description: 'Menu category not found in this chain' })
  createItem(
    @Param('chainId', new ParseUUIDPipe()) chainId: string,
    @Body() dto: CreateMenuItemDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menuService.createItem(chainId, dto, user);
  }

  @Patch('items/:itemId')
  @ApiOperation({ summary: 'Update a menu item: name, description, image, price, or category' })
  @ApiParam({ name: 'itemId', format: 'uuid' })
  @ApiOkResponse({ description: 'Menu item updated' })
  @ApiNotFoundResponse({ description: 'Menu item not found in this chain' })
  updateItem(
    @Param('chainId', new ParseUUIDPipe()) chainId: string,
    @Param('itemId', new ParseUUIDPipe()) itemId: string,
    @Body() dto: UpdateMenuItemDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menuService.updateItem(chainId, itemId, dto, user);
  }

  @Patch('items/:itemId/active')
  @ApiOperation({
    summary: 'Switch a menu item on or off for the whole chain',
    description: 'Switching it off stops every branch from selling it, whatever the branch set.',
  })
  @ApiParam({ name: 'itemId', format: 'uuid' })
  @ApiOkResponse({ description: 'Menu item switched' })
  @ApiNotFoundResponse({ description: 'Menu item not found in this chain' })
  setItemActive(
    @Param('chainId', new ParseUUIDPipe()) chainId: string,
    @Param('itemId', new ParseUUIDPipe()) itemId: string,
    @Body() dto: SetMenuItemActiveDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menuService.setItemActive(chainId, itemId, dto, user);
  }

  @Delete('items/:itemId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Delete a menu item',
    description: 'Order history keeps referring to the item, so it is removed from the menu only.',
  })
  @ApiParam({ name: 'itemId', format: 'uuid' })
  @ApiOkResponse({ description: 'Menu item deleted' })
  @ApiNotFoundResponse({ description: 'Menu item not found in this chain' })
  deleteItem(
    @Param('chainId', new ParseUUIDPipe()) chainId: string,
    @Param('itemId', new ParseUUIDPipe()) itemId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menuService.deleteItem(chainId, itemId, user);
  }

  @Get('items/:itemId/branches')
  @ApiOperation({ summary: 'Show which branches currently sell an item' })
  @ApiParam({ name: 'itemId', format: 'uuid' })
  @ApiOkResponse({ description: 'Every branch of the chain with its on/off state for this item' })
  @ApiNotFoundResponse({ description: 'Menu item not found in this chain' })
  listItemBranches(
    @Param('chainId', new ParseUUIDPipe()) chainId: string,
    @Param('itemId', new ParseUUIDPipe()) itemId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menuService.listItemBranches(chainId, itemId, user);
  }

  @Put('items/:itemId/branches')
  @ApiOperation({
    summary: 'Choose which branches sell an item',
    description: 'Send the full set of branch ids; any branch left out is switched off.',
  })
  @ApiParam({ name: 'itemId', format: 'uuid' })
  @ApiOkResponse({ description: 'Branch assignment saved' })
  @ApiBadRequestResponse({ description: 'A branch id does not belong to this chain' })
  @ApiNotFoundResponse({ description: 'Menu item not found in this chain' })
  setItemBranches(
    @Param('chainId', new ParseUUIDPipe()) chainId: string,
    @Param('itemId', new ParseUUIDPipe()) itemId: string,
    @Body() dto: SetMenuItemBranchesDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menuService.setItemBranches(chainId, itemId, dto, user);
  }

  @Get('items/:itemId/option-groups')
  @ApiOperation({ summary: 'List option groups attached to a menu item' })
  @ApiParam({ name: 'itemId', format: 'uuid' })
  @ApiOkResponse({ description: 'Attached option groups in display order' })
  @ApiNotFoundResponse({ description: 'Menu item not found in this chain' })
  listItemOptionGroups(
    @Param('chainId', new ParseUUIDPipe()) chainId: string,
    @Param('itemId', new ParseUUIDPipe()) itemId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menuService.listItemOptionGroups(chainId, itemId, user);
  }

  @Put('items/:itemId/option-groups')
  @ApiOperation({ summary: 'Replace the ordered option groups attached to a menu item' })
  @ApiParam({ name: 'itemId', format: 'uuid' })
  @ApiOkResponse({ description: 'Option-group attachments saved' })
  @ApiBadRequestResponse({ description: 'An option group does not belong to this chain' })
  @ApiNotFoundResponse({ description: 'Menu item not found in this chain' })
  setItemOptionGroups(
    @Param('chainId', new ParseUUIDPipe()) chainId: string,
    @Param('itemId', new ParseUUIDPipe()) itemId: string,
    @Body() dto: SetMenuItemOptionGroupsDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menuService.setItemOptionGroups(chainId, itemId, dto, user);
  }
}
