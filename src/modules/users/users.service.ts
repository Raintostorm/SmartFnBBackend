import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { UserStatus, type Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { AppRole } from '../auth/app-role.enum.js';

export const authUserInclude = {
  role: {
    select: {
      id: true,
      code: true,
      name: true,
    },
  },
  employee: {
    select: {
      id: true,
      employeeCode: true,
      branchId: true,
      firstName: true,
      lastName: true,
    },
  },
  customer: {
    select: {
      id: true,
      customerCode: true,
      firstName: true,
      lastName: true,
    },
  },
} satisfies Prisma.UserInclude;

export type AuthUserRecord = Prisma.UserGetPayload<{
  include: typeof authUserInclude;
}>;

export interface CreateCustomerInput {
  email: string;
  phone?: string;
  passwordHash: string;
  firstName: string;
  lastName: string;
  dateOfBirth?: Date;
  customerCode: string;
  roleId: string;
}

export interface CreateStaffInput {
  email: string;
  phone?: string;
  passwordHash: string;
  roleId: string;
  branchId: string;
  employeeCode: string;
  firstName: string;
  lastName: string;
  jobTitle?: string;
  dateOfBirth?: Date;
  hireDate?: Date;
}

export interface AccountStatusView {
  id: string;
  email: string;
  phone: string | null;
  status: UserStatus;
  role: string;
  updatedAt: Date;
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  findByEmailForAuth(email: string): Promise<AuthUserRecord | null> {
    return this.prisma.user.findFirst({
      where: {
        email,
        deletedAt: null,
      },
      include: authUserInclude,
    });
  }

  findByIdForAuth(id: string): Promise<AuthUserRecord | null> {
    return this.prisma.user.findFirst({
      where: {
        id,
        deletedAt: null,
      },
      include: authUserInclude,
    });
  }

  findRoleByCode(code: AppRole) {
    return this.prisma.role.findUnique({
      where: { code },
      select: { id: true, code: true },
    });
  }

  branchExists(id: string): Promise<boolean> {
    return this.prisma.branch
      .count({
        where: {
          id,
          deletedAt: null,
        },
      })
      .then((count) => count > 0);
  }

  createCustomer(input: CreateCustomerInput): Promise<AuthUserRecord> {
    return this.prisma.$transaction(async (transaction) => {
      const user = await transaction.user.create({
        data: {
          email: input.email,
          phone: input.phone,
          passwordHash: input.passwordHash,
          roleId: input.roleId,
        },
        select: { id: true },
      });

      await transaction.customer.create({
        data: {
          userId: user.id,
          customerCode: input.customerCode,
          firstName: input.firstName,
          lastName: input.lastName,
          dateOfBirth: input.dateOfBirth,
        },
      });

      return transaction.user.findUniqueOrThrow({
        where: { id: user.id },
        include: authUserInclude,
      });
    });
  }

  createStaff(input: CreateStaffInput): Promise<AuthUserRecord> {
    return this.prisma.$transaction(async (transaction) => {
      const user = await transaction.user.create({
        data: {
          email: input.email,
          phone: input.phone,
          passwordHash: input.passwordHash,
          roleId: input.roleId,
        },
        select: { id: true },
      });

      await transaction.employee.create({
        data: {
          userId: user.id,
          branchId: input.branchId,
          employeeCode: input.employeeCode,
          firstName: input.firstName,
          lastName: input.lastName,
          jobTitle: input.jobTitle,
          dateOfBirth: input.dateOfBirth,
          hireDate: input.hireDate,
        },
      });

      return transaction.user.findUniqueOrThrow({
        where: { id: user.id },
        include: authUserInclude,
      });
    });
  }

  async updateLastLogin(id: string): Promise<void> {
    await this.prisma.user.update({
      where: { id },
      data: { lastLoginAt: new Date() },
      select: { id: true },
    });
  }

  async updateAccountStatus(
    actorId: string,
    userId: string,
    status: UserStatus,
  ): Promise<AccountStatusView> {
    if (actorId === userId) {
      throw new BadRequestException('Administrators cannot change their own account status');
    }

    return this.prisma.$transaction(async (transaction) => {
      const target = await transaction.user.findFirst({
        where: {
          id: userId,
          deletedAt: null,
        },
        select: { id: true },
      });

      if (!target) {
        throw new NotFoundException('User not found');
      }

      const updatedUser = await transaction.user.update({
        where: { id: target.id },
        data: { status },
        select: {
          id: true,
          email: true,
          phone: true,
          status: true,
          updatedAt: true,
          role: { select: { code: true } },
        },
      });

      if (status !== UserStatus.ACTIVE) {
        await transaction.authSession.updateMany({
          where: {
            userId: target.id,
            revokedAt: null,
          },
          data: { revokedAt: new Date() },
        });
      }

      return {
        id: updatedUser.id,
        email: updatedUser.email,
        phone: updatedUser.phone,
        status: updatedUser.status,
        role: updatedUser.role.code,
        updatedAt: updatedUser.updatedAt,
      };
    });
  }
}
