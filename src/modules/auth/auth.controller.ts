import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { AppRole } from './app-role.enum.js';
import { SWAGGER_ACCESS_TOKEN } from './auth.constants.js';
import type { AuthenticatedUser, AuthResponse, RequestMetadata } from './auth.interfaces.js';
import { AuthService } from './auth.service.js';
import { CurrentUser } from './decorators/current-user.decorator.js';
import { Public } from './decorators/public.decorator.js';
import { Roles } from './decorators/roles.decorator.js';
import {
  AuthenticatedUserResponseDto,
  AuthResponseDto,
  MessageResponseDto,
} from './dto/auth-response.dto.js';
import { CreateStaffDto } from './dto/create-staff.dto.js';
import { CreateManagerDto } from './dto/create-manager.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { RefreshTokenDto } from './dto/refresh-token.dto.js';
import { SetupPasswordDto } from './dto/setup-password.dto.js';

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Roles(AppRole.OWNER)
  @Post('managers')
  @ApiBearerAuth(SWAGGER_ACCESS_TOKEN)
  @ApiOperation({
    summary: 'Create a MANAGER for one branch (owning OWNER)',
    description: 'An OWNER may select only a branch that belongs to one of their assigned chains.',
  })
  @ApiCreatedResponse({ type: AuthResponseDto })
  @ApiBadRequestResponse({ description: 'Request validation failed' })
  @ApiUnauthorizedResponse({ description: 'Access token is missing, invalid, or expired' })
  @ApiForbiddenResponse({ description: 'Only the owning OWNER can create this account' })
  @ApiNotFoundResponse({ description: 'Branch not found' })
  @ApiConflictResponse({ description: 'Email, phone, or employee code already exists' })
  registerManager(
    @Body() dto: CreateManagerDto,
    @Req() request: Request,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AuthResponse> {
    return this.authService.registerManager(user, dto, this.getRequestMetadata(request));
  }

  @Roles(AppRole.OWNER)
  @Post('staff')
  @ApiBearerAuth(SWAGGER_ACCESS_TOKEN)
  @ApiOperation({
    summary: 'Create a MANAGER account in an owned branch',
    deprecated: true,
    description:
      'Superseded by POST /auth/managers. An OWNER may only create MANAGER accounts; WAITER, ' +
      'KITCHEN, and CASHIER accounts are created by the branch manager.',
  })
  @ApiCreatedResponse({ type: AuthResponseDto })
  @ApiBadRequestResponse({ description: 'Request validation failed, or role is not MANAGER' })
  @ApiUnauthorizedResponse({ description: 'Access token is missing, invalid, or expired' })
  @ApiForbiddenResponse({ description: 'Only the owning OWNER can create staff accounts' })
  @ApiNotFoundResponse({ description: 'Branch not found' })
  @ApiConflictResponse({ description: 'Email, phone, or employee code already exists' })
  registerStaff(
    @Body() dto: CreateStaffDto,
    @Req() request: Request,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AuthResponse> {
    return this.authService.registerStaff(user, dto, this.getRequestMetadata(request));
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('setup-password')
  @ApiOperation({
    summary: 'Set or reset an OWNER or MANAGER password using a one-time email token',
  })
  @ApiOkResponse({ type: MessageResponseDto })
  @ApiUnauthorizedResponse({ description: 'Setup token is invalid or expired' })
  setupPassword(@Body() dto: SetupPasswordDto): Promise<{ message: string }> {
    return this.authService.setupPassword(dto);
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('login')
  @ApiOperation({ summary: 'Log in with email and password' })
  @ApiOkResponse({ type: AuthResponseDto })
  @ApiBadRequestResponse({ description: 'Request validation failed' })
  @ApiUnauthorizedResponse({ description: 'Credentials are invalid or the account is not active' })
  login(@Body() dto: LoginDto, @Req() request: Request): Promise<AuthResponse> {
    return this.authService.login(dto, this.getRequestMetadata(request));
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('refresh')
  @ApiOperation({ summary: 'Rotate a refresh token and issue a new token pair' })
  @ApiOkResponse({ type: AuthResponseDto })
  @ApiBadRequestResponse({ description: 'Request validation failed' })
  @ApiUnauthorizedResponse({ description: 'Refresh token is invalid, expired, or already used' })
  refresh(@Body() dto: RefreshTokenDto): Promise<AuthResponse> {
    return this.authService.refresh(dto.refreshToken);
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('logout')
  @ApiOperation({ summary: 'Log out the session represented by a refresh token' })
  @ApiOkResponse({ type: MessageResponseDto })
  @ApiBadRequestResponse({ description: 'Request validation failed' })
  async logout(@Body() dto: RefreshTokenDto): Promise<{ message: string }> {
    await this.authService.logout(dto.refreshToken);
    return { message: 'Logged out successfully' };
  }

  @HttpCode(HttpStatus.OK)
  @Post('logout-all')
  @ApiBearerAuth(SWAGGER_ACCESS_TOKEN)
  @ApiOperation({ summary: 'Log out all sessions of the current user' })
  @ApiOkResponse({ type: MessageResponseDto })
  @ApiUnauthorizedResponse({ description: 'Access token is missing, invalid, or expired' })
  async logoutAll(@CurrentUser() user: AuthenticatedUser): Promise<{ message: string }> {
    await this.authService.logoutAll(user.id);
    return { message: 'Logged out from all sessions successfully' };
  }

  @Get('me')
  @ApiBearerAuth(SWAGGER_ACCESS_TOKEN)
  @ApiOperation({ summary: 'Get the authenticated user context' })
  @ApiOkResponse({ type: AuthenticatedUserResponseDto })
  @ApiUnauthorizedResponse({ description: 'Access token is missing, invalid, or expired' })
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
