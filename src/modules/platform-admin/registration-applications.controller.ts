import { Body, Controller, Post } from '@nestjs/common';
import { ApiConflictResponse, ApiCreatedResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator.js';
import { SubmitRegistrationApplicationDto } from './dto/platform-admin.dto.js';
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
}
