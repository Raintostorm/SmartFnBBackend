import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppRole } from '../app-role.enum.js';
import { ROLES_KEY } from '../auth.constants.js';
import type { AuthenticatedRequest } from '../auth.interfaces.js';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<AppRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles?.length) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    if (!request.user || (!requiredRoles.includes(request.user.role) && !(request.user.role === AppRole.ADMIN && requiredRoles.includes(AppRole.PLATFORM_STAFF)))) {
      throw new ForbiddenException('You do not have permission to access this resource');
    }

    return true;
  }
}
