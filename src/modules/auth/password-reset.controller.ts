import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from './auth.service.js';
import { PasswordResetService } from './password-reset.service.js';
import { Public } from './decorators/public.decorator.js';
import { CurrentUser } from './decorators/current-user.decorator.js';
import type { AuthenticatedUser } from './auth.interfaces.js';
import { ConfirmPasswordResetDto, RejectPasswordResetDto, RequestPasswordResetDto } from './dto/password-reset.dto.js';

@Controller()
export class PasswordResetController {
  constructor(private readonly resets: PasswordResetService, private readonly auth: AuthService) {}

  @Public()
  @Post('auth/password-reset-requests')
  @HttpCode(202)
  request(@Body() dto: RequestPasswordResetDto, @Req() req: Request) {
    return this.resets.request(dto.email, { ipAddress: req.ip, userAgent: req.get('user-agent') });
  }

  @Public()
  @Get('auth/password-reset/verify')
  verify(@Req() req: Request) { return this.auth.verifyPasswordToken(String(req.query.token ?? '')); }

  @Public()
  @Post('auth/password-reset/confirm')
  confirm(@Body() dto: ConfirmPasswordResetDto) { return this.auth.setupPassword({ token: dto.token, password: dto.newPassword }); }

  @Get('password-reset-requests')
  list(@CurrentUser() actor: AuthenticatedUser) { return this.resets.list(actor); }

  @Get('password-reset-requests/count')
  count(@CurrentUser() actor: AuthenticatedUser) { return this.resets.count(actor); }

  @Post('password-reset-requests/:id/approve')
  approve(@CurrentUser() actor: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string) { return this.resets.resolve(actor, id); }

  @Post('password-reset-requests/:id/reject')
  reject(@CurrentUser() actor: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: RejectPasswordResetDto) { return this.resets.resolve(actor, id, dto.note); }

  @Post('password-reset-requests/:id/resend')
  resend(@CurrentUser() actor: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string) { return this.resets.resend(actor, id); }
}
