import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Put } from '@nestjs/common';
import {
  ApiBadGatewayResponse,
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { AppRole } from '../auth/app-role.enum.js';
import { SWAGGER_ACCESS_TOKEN } from '../auth/auth.constants.js';
import type { AuthenticatedUser } from '../auth/auth.interfaces.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { PayosChannelResponseDto, SavePayosChannelDto } from './dto/payos-channel.dto.js';
import { PayosChannelService } from './payos-channel.service.js';
import { ApiAuthenticatedOperation, ApiUuidPath } from '../../common/swagger/swagger.decorators.js';

@ApiTags('PayOS channel')
@ApiBearerAuth(SWAGGER_ACCESS_TOKEN)
@ApiAuthenticatedOperation()
@Roles(AppRole.OWNER)
@Controller('restaurant-chains/:chainId/payos-channel')
export class PayosChannelController {
  constructor(private readonly service: PayosChannelService) {}

  @Get()
  @ApiUuidPath('chainId', 'Restaurant chain')
  @ApiOperation({ summary: 'Get PayOS connection status without returning credentials' })
  @ApiOkResponse({ type: PayosChannelResponseDto })
  get(
    @Param('chainId', new ParseUUIDPipe()) chainId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.get(chainId, user);
  }

  @Put()
  @ApiUuidPath('chainId', 'Restaurant chain')
  @ApiOperation({
    summary: 'Verify the PayOS keys and webhook, then encrypt and save the channel',
  })
  @ApiOkResponse({ type: PayosChannelResponseDto })
  @ApiUnprocessableEntityResponse({ description: 'PayOS rejected the keys or webhook URL' })
  @ApiBadGatewayResponse({ description: 'PayOS is temporarily unavailable' })
  @ApiServiceUnavailableResponse({
    description: 'PAYOS_MASTER_KEY or PAYOS_WEBHOOK_BASE_URL is not configured',
  })
  save(
    @Param('chainId', new ParseUUIDPipe()) chainId: string,
    @Body() dto: SavePayosChannelDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.save(chainId, dto, user);
  }

  @Delete()
  @ApiUuidPath('chainId', 'Restaurant chain')
  @ApiOperation({ summary: 'Remove the PayOS channel credentials' })
  @ApiOkResponse({ type: PayosChannelResponseDto })
  remove(
    @Param('chainId', new ParseUUIDPipe()) chainId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.remove(chainId, user);
  }
}
