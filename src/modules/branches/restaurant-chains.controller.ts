import { Body, Controller, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
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

  @Post(':chainId/branches')
  @ApiOperation({ summary: 'Create a branch inside an owned restaurant chain' })
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
