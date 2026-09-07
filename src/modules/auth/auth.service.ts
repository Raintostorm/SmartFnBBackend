import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { UserStatus } from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import { type AuthUserRecord, UsersService } from '../users/users.service.js';
import { AppRole, isAppRole } from './app-role.enum.js';
import { ACCESS_TOKEN_TYPE, REFRESH_TOKEN_TYPE } from './auth.constants.js';
import type {
  AuthenticatedUser,
  AuthResponse,
  AuthUserView,
  JwtPayload,
  RequestMetadata,
} from './auth.interfaces.js';
import type { CreateStaffDto } from './dto/create-staff.dto.js';
import type { LoginDto } from './dto/login.dto.js';
import type { RegisterCustomerDto } from './dto/register-customer.dto.js';
import { PasswordService } from './password.service.js';

interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  refreshExpiresIn: number;
  refreshExpiresAt: Date;
}

@Injectable()
export class AuthService {
  private readonly accessSecret: string;
  private readonly refreshSecret: string;
  private readonly accessTtlSeconds: number;
  private readonly refreshTtlSeconds: number;
  private readonly issuer: string;
  private readonly audience: string;

  constructor(
    private readonly usersService: UsersService,
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly passwordService: PasswordService,
  ) {
    this.accessSecret = configService.getOrThrow<string>('JWT_ACCESS_SECRET');
    this.refreshSecret = configService.getOrThrow<string>('JWT_REFRESH_SECRET');
    this.accessTtlSeconds = configService.getOrThrow<number>('JWT_ACCESS_TTL_SECONDS');
    this.refreshTtlSeconds = configService.getOrThrow<number>('JWT_REFRESH_TTL_SECONDS');
    this.issuer = configService.getOrThrow<string>('JWT_ISSUER');
    this.audience = configService.getOrThrow<string>('JWT_AUDIENCE');
  }

  async registerCustomer(
    dto: RegisterCustomerDto,
    metadata: RequestMetadata,
  ): Promise<AuthResponse> {
    const role = await this.usersService.findRoleByCode(AppRole.CUSTOMER);

    if (!role) {
      throw new InternalServerErrorException('CUSTOMER role is not configured');
    }

    const passwordHash = await this.passwordService.hash(dto.password);

    try {
      const user = await this.usersService.createCustomer({
        email: this.normalizeEmail(dto.email),
        phone: dto.phone?.trim(),
        passwordHash,
        firstName: dto.firstName.trim(),
        lastName: dto.lastName.trim(),
        dateOfBirth: this.parseOptionalDate(dto.dateOfBirth),
        customerCode: this.generateCode('CUS'),
        roleId: role.id,
      });

      return this.createSession(user, metadata);
    } catch (error: unknown) {
      this.rethrowCreateUserError(error);
    }
  }

  async registerStaff(dto: CreateStaffDto, metadata: RequestMetadata): Promise<AuthResponse> {
    const role = await this.usersService.findRoleByCode(dto.role);

    if (!role) {
      throw new InternalServerErrorException(`${dto.role} role is not configured`);
    }

    if (!(await this.usersService.branchExists(dto.branchId))) {
      throw new NotFoundException('Branch not found');
    }

    const passwordHash = await this.passwordService.hash(dto.password);

    try {
      const user = await this.usersService.createStaff({
        email: this.normalizeEmail(dto.email),
        phone: dto.phone?.trim(),
        passwordHash,
        roleId: role.id,
        branchId: dto.branchId,
        employeeCode: dto.employeeCode.trim().toUpperCase(),
        firstName: dto.firstName.trim(),
        lastName: dto.lastName.trim(),
        jobTitle: dto.jobTitle?.trim(),
        dateOfBirth: this.parseOptionalDate(dto.dateOfBirth),
        hireDate: this.parseOptionalDate(dto.hireDate),
      });

      return this.createSession(user, metadata);
    } catch (error: unknown) {
      this.rethrowCreateUserError(error);
    }
  }

  async login(dto: LoginDto, metadata: RequestMetadata): Promise<AuthResponse> {
    const user = await this.usersService.findByEmailForAuth(this.normalizeEmail(dto.email));

    if (!user || !(await this.passwordService.verify(user.passwordHash, dto.password))) {
      throw new UnauthorizedException('Invalid email or password');
    }

    this.assertUserCanAuthenticate(user);
    await this.usersService.updateLastLogin(user.id);

    return this.createSession(user, metadata);
  }

  async refresh(refreshToken: string): Promise<AuthResponse> {
    const payload = await this.verifyRefreshToken(refreshToken);
    const now = new Date();
    const incomingHash = this.hashToken(refreshToken);
    const session = await this.prisma.authSession.findUnique({
      where: { id: payload.sid },
      select: {
        id: true,
        userId: true,
        refreshTokenHash: true,
        expiresAt: true,
        revokedAt: true,
      },
    });

    if (
      !session ||
      session.userId !== payload.sub ||
      session.revokedAt ||
      session.expiresAt <= now
    ) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (!this.hashesMatch(session.refreshTokenHash, incomingHash)) {
      await this.revokeSession(session.id, session.userId, now);
      throw new UnauthorizedException('Refresh token reuse detected');
    }

    const user = await this.usersService.findByIdForAuth(payload.sub);
    this.assertUserCanAuthenticate(user);

    const role = this.getAppRole(user);
    if (role !== payload.role) {
      throw new UnauthorizedException('User role has changed');
    }

    const tokens = await this.signTokenPair(user, session.id);
    const rotation = await this.prisma.authSession.updateMany({
      where: {
        id: session.id,
        userId: user.id,
        refreshTokenHash: incomingHash,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      data: {
        refreshTokenHash: this.hashToken(tokens.refreshToken),
        expiresAt: tokens.refreshExpiresAt,
        lastUsedAt: now,
      },
    });

    if (rotation.count !== 1) {
      await this.revokeSession(session.id, session.userId, now);
      throw new UnauthorizedException('Refresh token has already been used');
    }

    return this.buildAuthResponse(user, tokens);
  }

  async logout(refreshToken: string): Promise<void> {
    try {
      const payload = await this.verifyRefreshToken(refreshToken);
      await this.prisma.authSession.updateMany({
        where: {
          id: payload.sid,
          userId: payload.sub,
          revokedAt: null,
        },
        data: { revokedAt: new Date() },
      });
    } catch {
      // Logout is intentionally idempotent and does not reveal token validity.
    }
  }

  async logoutAll(userId: string): Promise<void> {
    await this.prisma.authSession.updateMany({
      where: {
        userId,
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });
  }

  async authenticateAccessToken(accessToken: string): Promise<AuthenticatedUser> {
    let payload: JwtPayload;

    try {
      payload = await this.jwtService.verifyAsync<JwtPayload>(accessToken, {
        secret: this.accessSecret,
        issuer: this.issuer,
        audience: this.audience,
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }

    if (
      payload.type !== ACCESS_TOKEN_TYPE ||
      !payload.sub ||
      !payload.sid ||
      !isAppRole(payload.role)
    ) {
      throw new UnauthorizedException('Invalid access token');
    }

    const session = await this.prisma.authSession.findFirst({
      where: {
        id: payload.sid,
        userId: payload.sub,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: { id: true },
    });

    if (!session) {
      throw new UnauthorizedException('Session is no longer active');
    }

    const user = await this.usersService.findByIdForAuth(payload.sub);
    this.assertUserCanAuthenticate(user);
    const role = this.getAppRole(user);

    if (role !== payload.role) {
      throw new UnauthorizedException('User role has changed');
    }

    return {
      id: user.id,
      email: user.email,
      phone: user.phone,
      role,
      sessionId: session.id,
      employeeId: user.employee?.id ?? null,
      customerId: user.customer?.id ?? null,
      branchId: user.employee?.branchId ?? null,
    };
  }

  private async createSession(
    user: AuthUserRecord,
    metadata: RequestMetadata,
  ): Promise<AuthResponse> {
    this.assertUserCanAuthenticate(user);
    const sessionId = randomUUID();
    const tokens = await this.signTokenPair(user, sessionId);

    await this.prisma.authSession.create({
      data: {
        id: sessionId,
        userId: user.id,
        refreshTokenHash: this.hashToken(tokens.refreshToken),
        userAgent: this.truncate(metadata.userAgent, 500),
        ipAddress: this.truncate(metadata.ipAddress, 64),
        expiresAt: tokens.refreshExpiresAt,
      },
    });

    return this.buildAuthResponse(user, tokens);
  }

  private async signTokenPair(user: AuthUserRecord, sessionId: string): Promise<TokenPair> {
    const role = this.getAppRole(user);
    const accessPayload: JwtPayload = {
      sub: user.id,
      sid: sessionId,
      role,
      type: ACCESS_TOKEN_TYPE,
      jti: randomUUID(),
    };
    const refreshPayload: JwtPayload = {
      sub: user.id,
      sid: sessionId,
      role,
      type: REFRESH_TOKEN_TYPE,
      jti: randomUUID(),
    };
    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(accessPayload, {
        secret: this.accessSecret,
        expiresIn: this.accessTtlSeconds,
        issuer: this.issuer,
        audience: this.audience,
      }),
      this.jwtService.signAsync(refreshPayload, {
        secret: this.refreshSecret,
        expiresIn: this.refreshTtlSeconds,
        issuer: this.issuer,
        audience: this.audience,
      }),
    ]);

    return {
      accessToken,
      refreshToken,
      expiresIn: this.accessTtlSeconds,
      refreshExpiresIn: this.refreshTtlSeconds,
      refreshExpiresAt: new Date(Date.now() + this.refreshTtlSeconds * 1000),
    };
  }

  private async verifyRefreshToken(refreshToken: string): Promise<JwtPayload> {
    try {
      const payload = await this.jwtService.verifyAsync<JwtPayload>(refreshToken, {
        secret: this.refreshSecret,
        issuer: this.issuer,
        audience: this.audience,
      });

      if (
        payload.type !== REFRESH_TOKEN_TYPE ||
        !payload.sub ||
        !payload.sid ||
        !isAppRole(payload.role)
      ) {
        throw new Error('Invalid refresh token payload');
      }

      return payload;
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
  }

  private buildAuthResponse(user: AuthUserRecord, tokens: TokenPair): AuthResponse {
    return {
      user: this.toUserView(user),
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      tokenType: 'Bearer',
      expiresIn: tokens.expiresIn,
      refreshExpiresIn: tokens.refreshExpiresIn,
    };
  }

  private toUserView(user: AuthUserRecord): AuthUserView {
    return {
      id: user.id,
      email: user.email,
      phone: user.phone,
      status: user.status,
      role: this.getAppRole(user),
      employee: user.employee,
      customer: user.customer,
    };
  }

  private assertUserCanAuthenticate(user: AuthUserRecord | null): asserts user is AuthUserRecord {
    if (!user || user.status !== UserStatus.ACTIVE || user.deletedAt) {
      throw new UnauthorizedException('User account is not active');
    }

    this.getAppRole(user);
  }

  private getAppRole(user: AuthUserRecord): AppRole {
    if (!isAppRole(user.role.code)) {
      throw new UnauthorizedException('User role is not supported');
    }

    return user.role.code;
  }

  private normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  private parseOptionalDate(value?: string): Date | undefined {
    return value ? new Date(`${value}T00:00:00.000Z`) : undefined;
  }

  private generateCode(prefix: string): string {
    return `${prefix}-${randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase()}`;
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private hashesMatch(expected: string, actual: string): boolean {
    const expectedBuffer = Buffer.from(expected, 'hex');
    const actualBuffer = Buffer.from(actual, 'hex');

    return (
      expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer)
    );
  }

  private truncate(value: string | undefined, maxLength: number): string | undefined {
    return value?.slice(0, maxLength);
  }

  private async revokeSession(sessionId: string, userId: string, revokedAt: Date): Promise<void> {
    await this.prisma.authSession.updateMany({
      where: {
        id: sessionId,
        userId,
        revokedAt: null,
      },
      data: { revokedAt },
    });
  }

  private rethrowCreateUserError(error: unknown): never {
    if (this.isPrismaUniqueConstraintError(error)) {
      throw new ConflictException('Email, phone, or account code already exists');
    }

    throw error;
  }

  private isPrismaUniqueConstraintError(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
  }
}
