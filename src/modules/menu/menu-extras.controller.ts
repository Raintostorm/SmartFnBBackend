import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Patch,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AppRole } from '../auth/app-role.enum.js';
import { SWAGGER_ACCESS_TOKEN } from '../auth/auth.constants.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import type { AuthenticatedUser } from '../auth/auth.interfaces.js';
import { SaveExtraDto, SetItemExtrasDto, ExtraAvailabilityDto } from './menu-extras.dto.js';
import { MenuExtrasService } from './menu-extras.service.js';
@ApiTags('Menu - chain wide (OWNER)')
@ApiBearerAuth(SWAGGER_ACCESS_TOKEN)
@Roles(AppRole.OWNER)
@Controller('restaurant-chains/:chainId/menu')
export class MenuExtrasController {
  constructor(private readonly service: MenuExtrasService) {}
  @Get('extras')
  @ApiOperation({ summary: 'List the chain extra library' })
  list(
    @Param('chainId', new ParseUUIDPipe()) chainId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.list(chainId, user);
  }
  @Post('extras')
  @ApiOperation({ summary: 'Create an extra with a default price' })
  create(
    @Param('chainId', new ParseUUIDPipe()) chainId: string,
    @Body() dto: SaveExtraDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.save(chainId, null, dto, user);
  }
  @Put('extras/:extraId')
  @ApiOperation({ summary: 'Update or disable an extra; item-specific prices remain unchanged' })
  save(
    @Param('chainId', new ParseUUIDPipe()) chainId: string,
    @Param('extraId', new ParseUUIDPipe()) id: string,
    @Body() dto: SaveExtraDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.save(chainId, id, dto, user);
  }
  @Delete('extras/:extraId')
  @ApiOperation({ summary: 'Disable an extra without deleting snapshots or item links' })
  disable(
    @Param('chainId', ParseUUIDPipe) chainId: string,
    @Param('extraId', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.disable(chainId, id, user);
  }
  @Get('items/:itemId/extras')
  @ApiOperation({ summary: 'Read item extras, item-specific prices and quantity limits' })
  itemExtras(
    @Param('chainId', new ParseUUIDPipe()) chainId: string,
    @Param('itemId', new ParseUUIDPipe()) itemId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.itemExtras(chainId, itemId, user);
  }

  @Put('items/:itemId/extras')
  @ApiOperation({
    summary: 'Replace item extras, prices, per-extra limits and total limit per cup',
  })
  assign(
    @Param('chainId', new ParseUUIDPipe()) chainId: string,
    @Param('itemId', new ParseUUIDPipe()) id: string,
    @Body() dto: SetItemExtrasDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.assign(chainId, id, dto, user);
  }
}
@ApiTags('Barista · Availability')
@ApiBearerAuth(SWAGGER_ACCESS_TOKEN)
@Roles(AppRole.MANAGER, AppRole.BARISTA)
@Controller('menu-extras')
export class ExtraAvailabilityController {
  constructor(private readonly service: MenuExtrasService) {}
  @Roles(AppRole.MANAGER)
  @Get('branch')
  @ApiOperation({ summary: 'List chain extras with availability in the assigned branch' })
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.service.listBranch(user);
  }
  @Patch(':extraId/availability')
  @ApiOperation({ summary: 'Set extra availability for the assigned branch' })
  set(
    @Param('extraId', new ParseUUIDPipe()) id: string,
    @Body() dto: ExtraAvailabilityDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.availability(user, id, dto.isAvailable);
  }
}
