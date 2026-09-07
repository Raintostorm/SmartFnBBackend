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
import { LoginDto } from './dto/login.dto.js';
import { RefreshTokenDto } from './dto/refresh-token.dto.js';
import { RegisterCustomerDto } from './dto/register-customer.dto.js';

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('register')
  @ApiOperation({ summary: 'Register a customer account' })
  @ApiCreatedResponse({ type: AuthResponseDto })
  @ApiBadRequestResponse({ description: 'Request validation failed' })
  @ApiConflictResponse({ description: 'Email, phone, or generated customer code already exists' })
  registerCustomer(
    @Body() dto: RegisterCustomerDto,
    @Req() request: Request,
  ): Promise<AuthResponse> {
    return this.authService.registerCustomer(dto, this.getRequestMetadata(request));
  }

  @Roles(AppRole.ADMIN)
  @Post('staff')
  @ApiBearerAuth(SWAGGER_ACCESS_TOKEN)
  @ApiOperation({ summary: 'Create a staff account and assign it to a branch' })
  @ApiCreatedResponse({ type: AuthResponseDto })
  @ApiBadRequestResponse({ description: 'Request validation failed' })
  @ApiUnauthorizedResponse({ description: 'Access token is missing, invalid, or expired' })
  @ApiForbiddenResponse({ description: 'Only ADMIN can create staff accounts' })
  @ApiNotFoundResponse({ description: 'Branch not found' })
  @ApiConflictResponse({ description: 'Email, phone, or employee code already exists' })
  registerStaff(@Body() dto: CreateStaffDto, @Req() request: Request): Promise<AuthResponse> {
    return this.authService.registerStaff(dto, this.getRequestMetadata(request));
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
