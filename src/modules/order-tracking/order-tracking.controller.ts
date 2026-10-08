import { Controller, Get, Header, Param, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Public } from '../auth/decorators/public.decorator.js';
import { OrderTrackingService } from './order-tracking.service.js';

@ApiTags('Public order tracking')
@Controller('public/track')
export class OrderTrackingController {
  constructor(private readonly tracking: OrderTrackingService) {}

  @Public()
  @Get(':token')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Get a privacy-limited counter-order pickup status' })
  track(@Param('token') token: string, @Req() request: Request) {
    return this.tracking.track(token, request.ip || request.socket.remoteAddress || 'unknown');
  }
}
