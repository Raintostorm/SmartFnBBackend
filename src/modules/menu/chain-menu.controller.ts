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
  ListMenuItemsQueryDto,
  SetMenuItemActiveDto,
  SetMenuItemBranchesDto,
  UpdateMenuCategoryDto,
  UpdateMenuItemDto,
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
}
