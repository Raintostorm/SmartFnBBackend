import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiConflictResponse, ApiCreatedResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator.js';
import { ActivationTokenDto, SubmitRegistrationApplicationDto } from './dto/platform-admin.dto.js';
import { PlatformAdminService } from './platform-admin.service.js';

@ApiTags('Business registration')
@Controller('registration-applications')
export class RegistrationApplicationsController {
  constructor(private readonly platformAdminService: PlatformAdminService) {}

  @Public()
  @Post()
  @ApiOperation({ summary: 'Submit a business registration application' })
  @ApiCreatedResponse({ description: 'Registration application created' })
  @ApiConflictResponse({ description: 'An application code conflict occurred' })
  submit(@Body() dto: SubmitRegistrationApplicationDto) {
    return this.platformAdminService.submitRegistrationApplication(dto);
  }

  @Public()
  @Get('activation')
  getActivation(@Query() query: ActivationTokenDto) {
    return this.platformAdminService.getActivation(query.token);
  }

  @Public()
  @Post('activation/trial')
  activateTrial(@Body() dto: ActivationTokenDto) {
    return this.platformAdminService.activateTrial(dto.token);
  }

  @Public()
  @Post('activation/checkout')
  createActivationCheckout(@Body() dto: ActivationTokenDto) {
    return this.platformAdminService.createActivationCheckout(dto.token);
  }

  @Public()
  @Get('activation/checkouts/:id')
  getActivationCheckout(@Param('id') id: string, @Query() query: ActivationTokenDto) {
    return this.platformAdminService.getActivationCheckout(query.token, id);
  }
}
