import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AppRole } from '../auth/app-role.enum.js';
import { SWAGGER_ACCESS_TOKEN } from '../auth/auth.constants.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import type { AuthenticatedUser } from '../auth/auth.interfaces.js';
import { CombosService } from './combos.service.js';
import {
  ComboBranchesDto,
  ComboBranchAvailabilityDto,
  SaveComboDto,
  UpdateComboDto,
} from './combos.dto.js';
@ApiTags('Menu - chain wide (OWNER)')
@ApiBearerAuth(SWAGGER_ACCESS_TOKEN)
@Roles(AppRole.OWNER)
@Controller('restaurant-chains/:chainId/combos')
export class CombosController {
  constructor(private readonly service: CombosService) {}
  @Get()
  @ApiOperation({ summary: 'List chain combos with components and branch settings' })
  list(@Param('chainId', ParseUUIDPipe) chain: string, @CurrentUser() user: AuthenticatedUser) {
    return this.service.list(chain, user);
  }
  @Post()
  @ApiOperation({ summary: 'Create a combo with 2–6 fixed or choice components' })
  create(
    @Param('chainId', ParseUUIDPipe) chain: string,
    @Body() dto: SaveComboDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.save(chain, null, dto, user);
  }
  @Patch(':id')
  @ApiOperation({ summary: 'Update a combo; historical order snapshots remain unchanged' })
  update(
    @Param('chainId', ParseUUIDPipe) chain: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateComboDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.save(chain, id, dto, user);
  }
  @Delete(':id')
  @ApiOperation({ summary: 'Stop selling a combo without deleting order history' })
  remove(
    @Param('chainId', ParseUUIDPipe) chain: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.remove(chain, id, user);
  }
  @Put(':id/branches')
  @ApiOperation({ summary: 'Assign combo branches; preserve existing branch prices' })
  branches(
    @Param('chainId', ParseUUIDPipe) chain: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ComboBranchesDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.assign(chain, id, dto.branchIds, user);
  }
}
@ApiTags('Barista · Availability')
@ApiBearerAuth(SWAGGER_ACCESS_TOKEN)
@Roles(AppRole.MANAGER, AppRole.BARISTA)
@Controller('branch-combos')
export class ComboAvailabilityController {
  constructor(private readonly service: CombosService) {}
  @Patch(':id/availability')
  @ApiOperation({
    summary:
      'Set combo availability in your assigned branch; component availability is also checked dynamically',
  })
  set(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ComboBranchAvailabilityDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.availability(user, id, dto.isAvailable);
  }
}
