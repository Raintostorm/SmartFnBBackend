import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { DisplayDeviceType, PosStationStatus, Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { AuthenticatedUser } from '../auth/auth.interfaces.js';
import type { CreateStationDto } from './dto/station.dto.js';

@Injectable()
export class StationsService {
  constructor(private readonly prisma: PrismaService) {}

  private employee(user: AuthenticatedUser) {
    if (!user.employeeId || !user.branchId) throw new ForbiddenException('An assigned branch employee is required');
    return { employeeId: user.employeeId, branchId: user.branchId };
  }

  list(user: AuthenticatedUser) {
    const actor = this.employee(user);
    return this.prisma.posStation.findMany({
      where: { branchId: actor.branchId },
      include: { displayDevices: { where: { revokedAt: null }, select: { id: true, type: true, name: true, pairedAt: true, lastSeenAt: true } } },
      orderBy: { name: 'asc' },
    });
  }

  create(user: AuthenticatedUser, dto: CreateStationDto) {
    const actor = this.employee(user);
    if (dto.printerConnection && dto.printerConnection !== 'NONE' && !dto.printerAddress?.trim())
      throw new BadRequestException('Printer address is required for WiFi or Bluetooth');
    return this.prisma.posStation.create({
      data: {
        branchId: actor.branchId,
        name: dto.name.trim(),
        printerConnection: dto.printerConnection,
        printerAddress: dto.printerAddress?.trim(),
      },
    });
  }

  async createPairingCode(type: DisplayDeviceType) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
      try {
        const request = await this.prisma.pairingCode.create({
          data: { codeHash: this.hash(code), deviceType: type, expiresAt: new Date(Date.now() + 5 * 60_000) },
        });
        return { pairingId: request.id, code, expiresAt: request.expiresAt };
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
        // Extremely unlikely six-digit collision; generate another code.
      }
    }
    throw new BadRequestException('Could not allocate a pairing code');
  }

  async pairCustomerDisplay(user: AuthenticatedUser, stationId: string, code: string, name?: string) {
    const actor = this.employee(user);
    return this.prisma.$transaction(async (tx) => {
      const station = await tx.posStation.findFirst({ where: { id: stationId, branchId: actor.branchId, status: PosStationStatus.ACTIVE } });
      if (!station) throw new NotFoundException('Active station was not found in your branch');
      const pairing = await tx.pairingCode.findUnique({ where: { codeHash: this.hash(code) } });
      if (!pairing || pairing.deviceType !== DisplayDeviceType.CUSTOMER_DISPLAY || pairing.consumedAt || pairing.expiresAt <= new Date())
        throw new BadRequestException('Pairing code is invalid, used, or expired');

      await tx.displayDevice.updateMany({
        where: { stationId, type: DisplayDeviceType.CUSTOMER_DISPLAY, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      const token = randomBytes(32).toString('base64url');
      const device = await tx.displayDevice.create({
        data: {
          type: DisplayDeviceType.CUSTOMER_DISPLAY,
          branchId: actor.branchId,
          stationId,
          tokenHash: this.hash(token),
          name: name?.trim(),
          pairedById: actor.employeeId,
        },
      });
      const consumed = await tx.pairingCode.updateMany({
        where: { id: pairing.id, consumedAt: null, expiresAt: { gt: new Date() } },
        data: { consumedAt: new Date() },
      });
      if (!consumed.count) throw new BadRequestException('Pairing code was already consumed');
      return { deviceId: device.id, deviceToken: token, stationId, branchId: actor.branchId };
    });
  }

  async revoke(user: AuthenticatedUser, deviceId: string) {
    const actor = this.employee(user);
    const result = await this.prisma.displayDevice.updateMany({
      where: { id: deviceId, branchId: actor.branchId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (!result.count) throw new NotFoundException('Active display device was not found in your branch');
    return { revoked: true };
  }

  private hash(value: string) {
    return createHash('sha256').update(value).digest('hex');
  }
}
