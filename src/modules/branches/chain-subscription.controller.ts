import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SWAGGER_ACCESS_TOKEN } from '../auth/auth.constants.js';
import { AppRole } from '../auth/app-role.enum.js';
import type { AuthenticatedUser } from '../auth/auth.interfaces.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { PlanQuotaService } from '../subscription/plan-quota.service.js';
import { ApiAuthenticatedOperation, ApiUuidPath } from '../../common/swagger/swagger.decorators.js';
import { BranchAccessService } from './branch-access.service.js';
import { ChainSubscriptionResponseDto } from './dto/branch-response.dto.js';

@ApiTags('Restaurant chain subscription')
@ApiBearerAuth(SWAGGER_ACCESS_TOKEN)
@ApiAuthenticatedOperation()
@Roles(AppRole.OWNER, AppRole.MANAGER)
@Controller('restaurant-chains/:chainId/subscription')
export class ChainSubscriptionController {
  constructor(
    private readonly access: BranchAccessService,
    private readonly quota: PlanQuotaService,
  ) {}

  @Get()
  @ApiUuidPath('chainId', 'Restaurant chain')
  @ApiOperation({ summary: 'Read plan status, expiration, features, and quota usage' })
  @ApiOkResponse({ type: ChainSubscriptionResponseDto })
  async get(
    @Param('chainId', new ParseUUIDPipe()) chainId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.access.assertCanReadChain(user, chainId);
    return { subscription: await this.quota.getSubscriptionSnapshot(chainId) };
  }
}
