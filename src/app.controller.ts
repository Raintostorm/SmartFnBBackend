import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AppService, type HealthResponse } from './app.service.js';
import { Public } from './modules/auth/decorators/public.decorator.js';

@ApiTags('System')
@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Public()
  @Get('health')
  @ApiOperation({ summary: 'Check API health' })
  @ApiOkResponse({
    schema: {
      example: {
        status: 'ok',
        service: 'smart-fnb-backend',
        timestamp: '2026-09-07T12:00:00.000Z',
      },
    },
  })
  getHealth(): HealthResponse {
    return this.appService.getHealth();
  }
}
