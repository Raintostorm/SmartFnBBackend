import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthenticatedRequest } from '../auth.interfaces.js';
import { IS_PUBLIC_KEY } from '../auth.constants.js';
import { AuthService } from '../auth.service.js';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authService: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = this.extractBearerToken(request.headers.authorization);
    request.user = await this.authService.authenticateAccessToken(token);

    return true;
  }

  private extractBearerToken(authorization?: string): string {
    const [type, token, ...rest] = authorization?.trim().split(/\s+/) ?? [];

    if (type?.toLowerCase() !== 'bearer' || !token || rest.length > 0) {
      throw new UnauthorizedException('Bearer access token is required');
    }

    return token;
  }
}
