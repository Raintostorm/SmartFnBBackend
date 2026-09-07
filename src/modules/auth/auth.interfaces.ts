import type { Request } from 'express';
import type { AppRole } from './app-role.enum.js';

export interface JwtPayload {
  sub: string;
  sid: string;
  role: AppRole;
  type: 'access' | 'refresh';
  jti: string;
  iat?: number;
  exp?: number;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  phone: string | null;
  role: AppRole;
  sessionId: string;
  employeeId: string | null;
  customerId: string | null;
  branchId: string | null;
}

export interface AuthenticatedRequest extends Request {
  user: AuthenticatedUser;
}

export interface RequestMetadata {
  ipAddress?: string;
  userAgent?: string;
}

export interface AuthUserView {
  id: string;
  email: string;
  phone: string | null;
  status: string;
  role: AppRole;
  employee: {
    id: string;
    employeeCode: string;
    branchId: string;
    firstName: string;
    lastName: string;
  } | null;
  customer: {
    id: string;
    customerCode: string;
    firstName: string;
    lastName: string;
  } | null;
}

export interface AuthResponse {
  user: AuthUserView;
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  refreshExpiresIn: number;
}
