import { Body, Controller, Get, Param, ParseUUIDPipe, Put } from '@nestjs/common';
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
import { ReplaceOwnerChainsDto } from './dto/owner-chain-assignment.dto.js';
import { OwnerAssignmentsService } from './owner-assignments.service.js';

@Roles(AppRole.ADMIN)
@ApiTags('Owner chain assignments - ADMIN')
@ApiBearerAuth(SWAGGER_ACCESS_TOKEN)
@ApiUnauthorizedResponse({ description: 'Access token is missing, invalid, or expired' })
@ApiForbiddenResponse({ description: 'Only ADMIN can assign owners to restaurant chains' })
@Controller()
export class OwnerAssignmentsController {
  constructor(private readonly ownerAssignmentsService: OwnerAssignmentsService) {}

  @Get('owners/:ownerId/chains')
  @ApiOperation({ summary: 'List restaurant chains assigned to an OWNER (ADMIN)' })
  @ApiParam({ name: 'ownerId', format: 'uuid', description: 'Owner profile ID' })
  @ApiOkResponse({ description: 'Owner chain assignments' })
  @ApiNotFoundResponse({ description: 'Owner profile not found' })
  getOwnerChains(@Param('ownerId', new ParseUUIDPipe()) ownerId: string) {
    return this.ownerAssignmentsService.getOwnerChains(ownerId);
  }

  @Put('owners/:ownerId/chains')
  @ApiOperation({ summary: 'Replace restaurant chains assigned to an OWNER (ADMIN)' })
  @ApiParam({ name: 'ownerId', format: 'uuid', description: 'Owner profile ID' })
  @ApiOkResponse({ description: 'Updated owner chain assignments' })
  @ApiBadRequestResponse({ description: 'One or more restaurant chains do not exist' })
  @ApiNotFoundResponse({ description: 'Owner profile not found' })
  replaceOwnerChains(
    @Param('ownerId', new ParseUUIDPipe()) ownerId: string,
    @Body() dto: ReplaceOwnerChainsDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.ownerAssignmentsService.replaceOwnerChains(ownerId, dto.chainIds, user.id);
  }

  @Get('restaurant-chains/:chainId/owners')
  @ApiOperation({ summary: 'List OWNER accounts assigned to a restaurant chain (ADMIN)' })
  @ApiParam({ name: 'chainId', format: 'uuid' })
  @ApiOkResponse({ description: 'Owners assigned to the restaurant chain' })
  @ApiNotFoundResponse({ description: 'Restaurant chain not found' })
  listChainOwners(@Param('chainId', new ParseUUIDPipe()) chainId: string) {
    return this.ownerAssignmentsService.listChainOwners(chainId);
  }
}
