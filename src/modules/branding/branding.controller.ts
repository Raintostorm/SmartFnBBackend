import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AppRole } from '../auth/app-role.enum.js';
import { SWAGGER_ACCESS_TOKEN } from '../auth/auth.constants.js';
import type { AuthenticatedUser } from '../auth/auth.interfaces.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { BrandingService } from './branding.service.js';
import { UpdateBrandingDto } from './dto/branding.dto.js';
import { RealtimePublisher } from '../../realtime/realtime.publisher.js';

@ApiTags('Restaurant branding')
@ApiBearerAuth(SWAGGER_ACCESS_TOKEN)
@Controller('restaurant-chains/:chainId/branding')
export class BrandingController {
  constructor(
    private readonly service: BrandingService,
    private readonly realtime: RealtimePublisher,
  ) {}

  @Roles(AppRole.OWNER, AppRole.MANAGER, AppRole.WAITER, AppRole.KITCHEN, AppRole.CASHIER)
  @Get()
  @ApiOperation({ summary: 'Get the branding visible to apps and printed bills' })
  get(
    @Param('chainId', new ParseUUIDPipe()) chainId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.get(chainId, user);
  }

  @Roles(AppRole.OWNER)
  @Put()
  @ApiOperation({ summary: 'Update restaurant-chain branding' })
  async update(
    @Param('chainId', new ParseUUIDPipe()) chainId: string,
    @Body() dto: UpdateBrandingDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const result = await this.service.update(chainId, dto, user);
    this.realtime.chain(chainId, 'branding.updated', result);
    return result;
  }

  @Roles(AppRole.OWNER)
  @Delete()
  @ApiOperation({ summary: 'Reset branding to the chain name and default colors' })
  async reset(
    @Param('chainId', new ParseUUIDPipe()) chainId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const result = await this.service.reset(chainId, user);
    this.realtime.chain(chainId, 'branding.reset', result);
    return result;
  }
}
