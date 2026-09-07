import { Controller, Get } from '@nestjs/common';
import { AppService, type HealthResponse } from './app.service.js';
import { Public } from './modules/auth/decorators/public.decorator.js';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Public()
  @Get('health')
  getHealth(): HealthResponse {
    return this.appService.getHealth();
  }
}
