import { Body, Controller, Delete, Get, Headers, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { ApiAuthenticatedOperation } from '../../common/swagger/swagger.decorators.js';
import { SWAGGER_DEVICE_TOKEN } from '../../swagger.setup.js';
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
  @ApiSecurity(SWAGGER_DEVICE_TOKEN)
  @ApiOperation({ summary: 'List ready call numbers using a calling-display device token' })
  callingDisplayReadyOrders(@Headers('authorization') authorization?: string) {
    return this.stations.callingDisplayReadyOrders(authorization);
  }

  @Public()
  @Get('public/customer-display/context')
  @ApiSecurity(SWAGGER_DEVICE_TOKEN)
  @ApiOperation({ summary: 'Get the paired station and latest customer-display state' })
  customerDisplayContext(@Headers('authorization') authorization?: string) {
    return this.stations.customerDisplayContext(authorization);
  }

  @Get('stations')
  @ApiBearerAuth(SWAGGER_ACCESS_TOKEN)
  @ApiAuthenticatedOperation()
  @Roles(AppRole.MANAGER, AppRole.CASHIER)
  @ApiOperation({ summary: 'List POS stations and paired displays in the assigned branch' })
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.stations.list(user);
  }

  @Post('stations')
  @ApiBearerAuth(SWAGGER_ACCESS_TOKEN)
  @ApiAuthenticatedOperation()
  @Roles(AppRole.MANAGER)
  @ApiOperation({ summary: 'Create a POS station in the assigned branch' })
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateStationDto) {
    return this.stations.create(user, dto);
  }

  @Post('stations/pair-customer-display')
  @ApiBearerAuth(SWAGGER_ACCESS_TOKEN)
  @ApiAuthenticatedOperation()
  @Roles(AppRole.MANAGER, AppRole.CASHIER)
  @ApiOperation({ summary: 'Pair a customer display with one POS station' })
  pair(@CurrentUser() user: AuthenticatedUser, @Body() dto: PairCustomerDisplayDto) {
    return this.stations.pairCustomerDisplay(user, dto.stationId, dto.code, dto.deviceName);
  }

  @Post('stations/pair-calling-display')
  @ApiBearerAuth(SWAGGER_ACCESS_TOKEN)
  @ApiAuthenticatedOperation()
  @Roles(AppRole.MANAGER)
  @ApiOperation({ summary: 'Pair a calling display with the assigned branch' })
  pairCallingDisplay(@CurrentUser() user: AuthenticatedUser, @Body() dto: PairCallingDisplayDto) {
    return this.stations.pairCallingDisplay(user, dto.code, dto.deviceName);
  }

  @Delete('display-devices/:deviceId')
  @ApiBearerAuth(SWAGGER_ACCESS_TOKEN)
  @ApiAuthenticatedOperation()
  @Roles(AppRole.MANAGER)
  @ApiOperation({ summary: 'Revoke a paired display device' })
  revoke(
    @CurrentUser() user: AuthenticatedUser,
    @Param('deviceId', new ParseUUIDPipe()) id: string,
  ) {
    return this.stations.revoke(user, id);
  }
}
