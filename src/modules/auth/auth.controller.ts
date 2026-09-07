import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { AppRole } from './app-role.enum.js';
import type { AuthenticatedUser, AuthResponse, RequestMetadata } from './auth.interfaces.js';
import { AuthService } from './auth.service.js';
import { CurrentUser } from './decorators/current-user.decorator.js';
import { Public } from './decorators/public.decorator.js';
import { Roles } from './decorators/roles.decorator.js';
import { CreateStaffDto } from './dto/create-staff.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { RefreshTokenDto } from './dto/refresh-token.dto.js';
import { RegisterCustomerDto } from './dto/register-customer.dto.js';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('register')
  registerCustomer(
    @Body() dto: RegisterCustomerDto,
    @Req() request: Request,
  ): Promise<AuthResponse> {
    return this.authService.registerCustomer(dto, this.getRequestMetadata(request));
  }

  @Roles(AppRole.ADMIN)
  @Post('staff')
  registerStaff(@Body() dto: CreateStaffDto, @Req() request: Request): Promise<AuthResponse> {
    return this.authService.registerStaff(dto, this.getRequestMetadata(request));
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('login')
  login(@Body() dto: LoginDto, @Req() request: Request): Promise<AuthResponse> {
    return this.authService.login(dto, this.getRequestMetadata(request));
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('refresh')
  refresh(@Body() dto: RefreshTokenDto): Promise<AuthResponse> {
    return this.authService.refresh(dto.refreshToken);
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('logout')
  async logout(@Body() dto: RefreshTokenDto): Promise<{ message: string }> {
    await this.authService.logout(dto.refreshToken);
    return { message: 'Logged out successfully' };
  }

  @HttpCode(HttpStatus.OK)
  @Post('logout-all')
  async logoutAll(@CurrentUser() user: AuthenticatedUser): Promise<{ message: string }> {
    await this.authService.logoutAll(user.id);
    return { message: 'Logged out from all sessions successfully' };
  }

  @Get('me')
  getMe(@CurrentUser() user: AuthenticatedUser): AuthenticatedUser {
    return user;
  }

  private getRequestMetadata(request: Request): RequestMetadata {
    return {
      ipAddress: request.ip,
      userAgent: request.get('user-agent'),
    };
  }
}
