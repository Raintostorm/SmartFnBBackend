import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AppRole } from '../auth/app-role.enum.js';
import { SWAGGER_ACCESS_TOKEN } from '../auth/auth.constants.js';
import type { AuthenticatedUser } from '../auth/auth.interfaces.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { CreatePlatformStaffDto, PlatformStaffAccountNoteDto } from './dto/platform-staff-account.dto.js';
import { PlatformStaffAccountsService } from './platform-staff-accounts.service.js';

@Roles(AppRole.ADMIN)
@ApiTags('Platform Staff accounts')
@ApiBearerAuth(SWAGGER_ACCESS_TOKEN)
@Controller('admin/platform-staff-accounts')
export class PlatformStaffAccountsController {
  constructor(private readonly service: PlatformStaffAccountsService) {}

  @Get()
  list() { return this.service.list(); }

  @Post()
  create(@Body() dto: CreatePlatformStaffDto, @CurrentUser() actor: AuthenticatedUser) { return this.service.create(dto.email, dto.note, actor.id); }

  @Post(':id/lock')
  lock(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: PlatformStaffAccountNoteDto, @CurrentUser() actor: AuthenticatedUser) { return this.service.setLocked(id, true, dto.note, actor.id); }

  @Post(':id/unlock')
  unlock(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: PlatformStaffAccountNoteDto, @CurrentUser() actor: AuthenticatedUser) { return this.service.setLocked(id, false, dto.note, actor.id); }

  @Post(':id/reset-password')
  resetPassword(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: PlatformStaffAccountNoteDto, @CurrentUser() actor: AuthenticatedUser) { return this.service.resetPassword(id, dto.note, actor.id); }
}
