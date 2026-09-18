import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import {
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

@Roles(AppRole.OWNER)
@ApiTags('Restaurant chains - OWNER')
@ApiBearerAuth(SWAGGER_ACCESS_TOKEN)
@ApiUnauthorizedResponse({ description: 'Access token is missing, invalid, or expired' })
@ApiForbiddenResponse({ description: 'Role or restaurant-chain ownership is insufficient' })
@Controller('restaurant-chains')
export class RestaurantChainsController {
  constructor(private readonly branchesService: BranchesService) {}

  @Get()
  @ApiOperation({
    summary: 'List the restaurant chains assigned to the current OWNER',
    description: 'Each chain carries its service plan and the current usage against its limits.',
  })
  @ApiOkResponse({ description: 'Owned restaurant chains with plan usage' })
  listChains(@CurrentUser() user: AuthenticatedUser) {
    return this.branchesService.listOwnerChains(user);
  }

  @Get(':chainId/overview')
  @ApiOperation({
    summary: 'Operating status of every branch in one chain, on a single screen',
    description:
      'Returns each branch with its status, the schedule that applies today in the branch timezone, ' +
      'whether it is open right now, and the remaining service-plan quota.',
  })
  @ApiParam({ name: 'chainId', format: 'uuid' })
  @ApiOkResponse({ description: 'Branch status overview' })
  @ApiNotFoundResponse({ description: 'Restaurant chain not found' })
  getOverview(
    @Param('chainId', new ParseUUIDPipe()) chainId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.branchesService.getChainOverview(chainId, user);
  }

  @Post(':chainId/branches')
  @ApiOperation({
    summary: 'Create a branch inside an owned restaurant chain',
    description:
      'openTime and closeTime seed the same schedule for all seven days; refine a single day ' +
      'through PUT /branches/{branchId}/operating-hours/{dayOfWeek}.',
  })
  @ApiParam({ name: 'chainId', format: 'uuid' })
  @ApiCreatedResponse({ description: 'Branch created' })
  @ApiConflictResponse({
    description:
      'Branch code already exists, or the service plan branch limit is reached (the body then ' +
      'carries error=PLAN_LIMIT_REACHED with suggestedPlans)',
  })
  @ApiNotFoundResponse({ description: 'Restaurant chain not found' })
  createBranch(
    @Param('chainId', new ParseUUIDPipe()) chainId: string,
    @Body() dto: CreateBranchDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.branchesService.createBranch(chainId, dto, user);
  }
}
