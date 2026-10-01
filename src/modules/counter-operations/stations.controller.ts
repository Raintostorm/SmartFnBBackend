import { Body, Controller, Delete, Get, Headers, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthenticatedUser } from '../auth/auth.interfaces.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Public } from '../auth/decorators/public.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { AppRole } from '../auth/app-role.enum.js';
import { SWAGGER_ACCESS_TOKEN } from '../auth/auth.constants.js';
import {
  CreatePairingCodeDto,
  CreateStationDto,
  PairCallingDisplayDto,
  PairCustomerDisplayDto,
} from './dto/station.dto.js';
import { StationsService } from './stations.service.js';

@ApiTags('POS stations and displays')
@Controller()
export class StationsController {
  constructor(private readonly stations: StationsService) {}

  @Public()
  @Post('device-pairing/codes')
  @ApiOperation({ summary: 'Create a six-digit, five-minute device pairing code' })
  createPairingCode(@Body() dto: CreatePairingCodeDto) {
    return this.stations.createPairingCode(dto.deviceType);
  }

  @Public()
  @Get('public/calling-display/ready-orders')
  @ApiOperation({ summary: 'List ready call numbers using a calling-display device token' })
  callingDisplayReadyOrders(@Headers('authorization') authorization?: string) {
    return this.stations.callingDisplayReadyOrders(authorization);
  }

  @Get('stations')
  @ApiBearerAuth(SWAGGER_ACCESS_TOKEN)
  @Roles(AppRole.MANAGER, AppRole.CASHIER)
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.stations.list(user);
  }

  @Post('stations')
  @ApiBearerAuth(SWAGGER_ACCESS_TOKEN)
  @Roles(AppRole.MANAGER)
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateStationDto) {
    return this.stations.create(user, dto);
  }

  @Post('stations/pair-customer-display')
  @ApiBearerAuth(SWAGGER_ACCESS_TOKEN)
  @Roles(AppRole.MANAGER, AppRole.CASHIER)
  pair(@CurrentUser() user: AuthenticatedUser, @Body() dto: PairCustomerDisplayDto) {
    return this.stations.pairCustomerDisplay(user, dto.stationId, dto.code, dto.deviceName);
  }

  @Post('stations/pair-calling-display')
  @ApiBearerAuth(SWAGGER_ACCESS_TOKEN)
  @Roles(AppRole.MANAGER)
  pairCallingDisplay(@CurrentUser() user: AuthenticatedUser, @Body() dto: PairCallingDisplayDto) {
    return this.stations.pairCallingDisplay(user, dto.code, dto.deviceName);
  }

  @Delete('display-devices/:deviceId')
  @ApiBearerAuth(SWAGGER_ACCESS_TOKEN)
  @Roles(AppRole.MANAGER)
  revoke(
    @CurrentUser() user: AuthenticatedUser,
    @Param('deviceId', new ParseUUIDPipe()) id: string,
  ) {
    return this.stations.revoke(user, id);
  }
}
