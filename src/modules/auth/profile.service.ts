import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { AuthenticatedUser } from './auth.interfaces.js';
import type { UpdateProfileDto } from './dto/profile.dto.js';

type ProfileKind = 'OWNER' | 'EMPLOYEE' | 'NONE';

/**
 * CM-02: every authenticated user views and edits only their own profile (the id always comes
 * from the access token). Brand Manager → owners row; Store Manager/Cashier/Barista → employees
 * row; Platform Admin/Staff have no personal profile row, so only the phone is editable.
 */
@Injectable()
export class ProfileService {
  constructor(private readonly prisma: PrismaService) {}

  async get(actor: Pick<AuthenticatedUser, 'id'>) {
    const user = await this.prisma.user.findFirst({
      where: { id: actor.id, deletedAt: null },
      select: {
        id: true, email: true, phone: true, role: { select: { code: true } },
        owner: { select: { firstName: true, lastName: true, dateOfBirth: true } },
        employee: { select: { firstName: true, lastName: true, dateOfBirth: true, jobTitle: true, branch: { select: { name: true } } } },
      },
    });
    if (!user) throw new NotFoundException('Account not found');
    const profile = user.owner ?? user.employee ?? null;
    const kind: ProfileKind = user.owner ? 'OWNER' : user.employee ? 'EMPLOYEE' : 'NONE';
    return {
      id: user.id,
      email: user.email,
      emailEditable: false,
      role: user.role.code,
      phone: user.phone,
      profileKind: kind,
      firstName: profile?.firstName ?? null,
      lastName: profile?.lastName ?? null,
      fullName: profile ? `${profile.firstName} ${profile.lastName}`.trim() : null,
      dateOfBirth: profile?.dateOfBirth ? profile.dateOfBirth.toISOString().slice(0, 10) : null,
      branchName: user.employee?.branch.name ?? null,
      jobTitle: user.employee?.jobTitle ?? null,
      editableFields: kind === 'NONE' ? ['phone'] : ['firstName', 'lastName', 'phone', 'dateOfBirth'],
    };
  }

  async update(actor: Pick<AuthenticatedUser, 'id'>, dto: UpdateProfileDto) {
    const current = await this.get(actor);
    const personal = dto.firstName !== undefined || dto.lastName !== undefined || dto.dateOfBirth !== undefined;
    if (personal && current.profileKind === 'NONE')
      throw new BadRequestException('This account has no personal profile record; only the phone can be updated');
    if (dto.dateOfBirth) {
      const dob = new Date(`${dto.dateOfBirth}T00:00:00Z`);
      const age = (Date.now() - dob.getTime()) / (365.25 * 86_400_000);
      if (Number.isNaN(age) || age < 15 || age > 100) throw new BadRequestException('dateOfBirth is out of range');
    }
    const profileData = {
      ...(dto.firstName !== undefined ? { firstName: dto.firstName } : {}),
      ...(dto.lastName !== undefined ? { lastName: dto.lastName } : {}),
      ...(dto.dateOfBirth !== undefined ? { dateOfBirth: dto.dateOfBirth ? new Date(`${dto.dateOfBirth}T00:00:00Z`) : null } : {}),
    };
    try {
      await this.prisma.$transaction(async (tx) => {
        if (dto.phone !== undefined) await tx.user.update({ where: { id: actor.id }, data: { phone: dto.phone } });
        if (Object.keys(profileData).length) {
          if (current.profileKind === 'OWNER') await tx.owner.update({ where: { userId: actor.id }, data: profileData });
          else await tx.employee.update({ where: { userId: actor.id }, data: profileData });
        }
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        throw new ConflictException('This phone number is already used by another account');
      throw error;
    }
    return this.get(actor);
  }
}
