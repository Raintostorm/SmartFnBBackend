import { SetMetadata } from '@nestjs/common';
import type { AppRole } from '../app-role.enum.js';
import { ROLES_KEY } from '../auth.constants.js';

export const Roles = (...roles: AppRole[]) => SetMetadata(ROLES_KEY, roles);
