import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
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
import { BranchesService } from './branches.service.js';
import { CreateBranchDto } from './dto/branch.dto.js';
import {
  CreateRestaurantChainDto,
  UpdateRestaurantChainDto,
  UpdateRestaurantChainStatusDto,
} from './dto/restaurant-chain.dto.js';

@Roles(AppRole.ADMIN)
@ApiTags('Restaurant chains - ADMIN')
@ApiBearerAuth(SWAGGER_ACCESS_TOKEN)
@ApiUnauthorizedResponse({ description: 'Access token is missing, invalid, or expired' })
@ApiForbiddenResponse({ description: 'Role or restaurant-chain ownership is insufficient' })
@Controller('restaurant-chains')
export class RestaurantChainsController {
  constructor(private readonly branchesService: BranchesService) {}

  @Post()
  @ApiOperation({ summary: 'Create a restaurant chain (ADMIN)' })
  @ApiCreatedResponse({ description: 'Restaurant chain created' })
  @ApiConflictResponse({ description: 'Restaurant chain code already exists' })
  create(@Body() dto: CreateRestaurantChainDto) {
    return this.branchesService.createChain(dto);
  }

  @Get()
  @ApiOperation({ summary: 'List restaurant chains (ADMIN)' })
  @ApiOkResponse({ description: 'Restaurant chains with branch counts' })
  list() {
    return this.branchesService.listChains();
  }

  @Get(':chainId')
  @ApiOperation({ summary: 'Get a restaurant chain and its branches (ADMIN)' })
  @ApiParam({ name: 'chainId', format: 'uuid' })
  @ApiOkResponse({ description: 'Restaurant chain detail' })
  @ApiNotFoundResponse({ description: 'Restaurant chain not found' })
  get(@Param('chainId', new ParseUUIDPipe()) chainId: string) {
    return this.branchesService.getChain(chainId);
  }

  @Patch(':chainId')
  @ApiOperation({ summary: 'Update restaurant chain information (ADMIN)' })
  @ApiParam({ name: 'chainId', format: 'uuid' })
  @ApiOkResponse({ description: 'Restaurant chain updated' })
  @ApiBadRequestResponse({ description: 'Request body is invalid' })
  @ApiConflictResponse({ description: 'Restaurant chain code already exists' })
  @ApiNotFoundResponse({ description: 'Restaurant chain not found' })
  update(
    @Param('chainId', new ParseUUIDPipe()) chainId: string,
    @Body() dto: UpdateRestaurantChainDto,
  ) {
    return this.branchesService.updateChain(chainId, dto);
  }

  @Patch(':chainId/status')
  @ApiOperation({ summary: 'Activate or deactivate a restaurant chain (ADMIN)' })
  @ApiParam({ name: 'chainId', format: 'uuid' })
  @ApiOkResponse({ description: 'Restaurant chain status updated' })
  @ApiNotFoundResponse({ description: 'Restaurant chain not found' })
  updateStatus(
    @Param('chainId', new ParseUUIDPipe()) chainId: string,
    @Body() dto: UpdateRestaurantChainStatusDto,
  ) {
    return this.branchesService.updateChainStatus(chainId, dto.status);
  }

  @Post(':chainId/branches')
  @Roles(AppRole.ADMIN, AppRole.OWNER)
  @ApiOperation({ summary: 'Create a branch inside a restaurant chain (ADMIN or owning OWNER)' })
  @ApiParam({ name: 'chainId', format: 'uuid' })
  @ApiCreatedResponse({ description: 'Branch created' })
  @ApiConflictResponse({ description: 'Branch code already exists' })
  @ApiNotFoundResponse({ description: 'Restaurant chain not found' })
  createBranch(
    @Param('chainId', new ParseUUIDPipe()) chainId: string,
    @Body() dto: CreateBranchDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.branchesService.createBranch(chainId, dto, user);
  }
}
