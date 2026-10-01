import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import {
  DisplayDeviceType,
  OrderPaymentStatus,
  OrderStatus,
  OrderType,
  PosStationStatus,
  Prisma,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { AuthenticatedUser } from '../auth/auth.interfaces.js';
import { BranchAccessService } from '../branches/branch-access.service.js';
import type { CreateStationDto } from './dto/station.dto.js';

@Injectable()
export class StationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly branchAccess: BranchAccessService,
  ) {}

  private employee(user: AuthenticatedUser) {
    if (!user.employeeId || !user.branchId)
      throw new ForbiddenException('An assigned branch employee is required');
    return { employeeId: user.employeeId, branchId: user.branchId };
  }

  list(user: AuthenticatedUser) {
    const actor = this.employee(user);
    return this.prisma.posStation.findMany({
      where: { branchId: actor.branchId },
      include: {
        displayDevices: {
          where: { revokedAt: null },
          select: { id: true, type: true, name: true, pairedAt: true, lastSeenAt: true },
        },
      },
      orderBy: { name: 'asc' },
    });
  }

  async create(user: AuthenticatedUser, dto: CreateStationDto) {
    const actor = this.employee(user);
    await this.branchAccess.assertSubscriptionAllowsWrite(actor.branchId);
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
      const deviceToken = randomBytes(32).toString('base64url');
      try {
        const request = await this.prisma.pairingCode.create({
          data: {
            codeHash: this.hash(code),
            deviceTokenHash: this.hash(deviceToken),
            deviceType: type,
            expiresAt: new Date(Date.now() + 5 * 60_000),
          },
        });
        return { pairingId: request.id, code, deviceToken, expiresAt: request.expiresAt };
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002')
          throw error;
        // Extremely unlikely six-digit collision; generate another code.
      }
    }
    throw new BadRequestException('Could not allocate a pairing code');
  }

  async callingDisplayReadyOrders(authorization?: string) {
    const device = await this.authenticateDisplayDevice(
      authorization,
      DisplayDeviceType.CALLING_DISPLAY,
    );
    return this.prisma.order.findMany({
      where: {
        branchId: device.branchId,
        type: OrderType.COUNTER_PICKUP,
        paymentStatus: OrderPaymentStatus.PAID,
        status: OrderStatus.READY,
      },
      select: { id: true, orderCode: true, callNumber: true, readyAt: true },
      orderBy: { readyAt: 'asc' },
    });
  }

  async pairCustomerDisplay(
    user: AuthenticatedUser,
    stationId: string,
    code: string,
    name?: string,
  ) {
    const actor = this.employee(user);
    await this.branchAccess.assertSubscriptionAllowsWrite(actor.branchId);
    return this.prisma.$transaction(async (tx) => {
      const station = await tx.posStation.findFirst({
        where: { id: stationId, branchId: actor.branchId, status: PosStationStatus.ACTIVE },
      });
      if (!station) throw new NotFoundException('Active station was not found in your branch');
      const pairing = await tx.pairingCode.findUnique({ where: { codeHash: this.hash(code) } });
      if (
        !pairing ||
        !pairing.deviceTokenHash ||
        pairing.deviceType !== DisplayDeviceType.CUSTOMER_DISPLAY ||
        pairing.consumedAt ||
        pairing.expiresAt <= new Date()
      )
        throw new BadRequestException('Pairing code is invalid, used, or expired');

      await tx.displayDevice.updateMany({
        where: { stationId, type: DisplayDeviceType.CUSTOMER_DISPLAY, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      const device = await tx.displayDevice.create({
        data: {
          type: DisplayDeviceType.CUSTOMER_DISPLAY,
          branchId: actor.branchId,
          stationId,
          tokenHash: pairing.deviceTokenHash,
          name: name?.trim(),
          pairedById: actor.employeeId,
        },
      });
      const consumed = await tx.pairingCode.updateMany({
        where: { id: pairing.id, consumedAt: null, expiresAt: { gt: new Date() } },
        data: { consumedAt: new Date() },
      });
      if (!consumed.count) throw new BadRequestException('Pairing code was already consumed');
      return { deviceId: device.id, stationId, branchId: actor.branchId };
    });
  }

  async pairCallingDisplay(user: AuthenticatedUser, code: string, name?: string) {
    const actor = this.employee(user);
    await this.branchAccess.assertSubscriptionAllowsWrite(actor.branchId);
    return this.prisma.$transaction(async (tx) => {
      const pairing = await tx.pairingCode.findUnique({ where: { codeHash: this.hash(code) } });
      if (
        !pairing ||
        !pairing.deviceTokenHash ||
        pairing.deviceType !== DisplayDeviceType.CALLING_DISPLAY ||
        pairing.consumedAt ||
        pairing.expiresAt <= new Date()
      ) {
        throw new BadRequestException('Pairing code is invalid, used, or expired');
      }

      await tx.displayDevice.updateMany({
        where: {
          branchId: actor.branchId,
          type: DisplayDeviceType.CALLING_DISPLAY,
          revokedAt: null,
        },
        data: { revokedAt: new Date() },
      });
      const device = await tx.displayDevice.create({
        data: {
          type: DisplayDeviceType.CALLING_DISPLAY,
          branchId: actor.branchId,
          tokenHash: pairing.deviceTokenHash,
          name: name?.trim(),
          pairedById: actor.employeeId,
        },
      });
      const consumed = await tx.pairingCode.updateMany({
        where: { id: pairing.id, consumedAt: null, expiresAt: { gt: new Date() } },
        data: { consumedAt: new Date() },
      });
      if (!consumed.count) throw new BadRequestException('Pairing code was already consumed');
      return { deviceId: device.id, branchId: actor.branchId };
    });
  }

  async revoke(user: AuthenticatedUser, deviceId: string) {
    const actor = this.employee(user);
    await this.branchAccess.assertSubscriptionAllowsWrite(actor.branchId);
    const result = await this.prisma.displayDevice.updateMany({
      where: { id: deviceId, branchId: actor.branchId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (!result.count)
      throw new NotFoundException('Active display device was not found in your branch');
    return { revoked: true };
  }

  private hash(value: string) {
    return createHash('sha256').update(value).digest('hex');
  }

  private async authenticateDisplayDevice(
    authorization: string | undefined,
    type: DisplayDeviceType,
  ) {
    const [scheme, token] = authorization?.trim().split(/\s+/) ?? [];
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      throw new ForbiddenException('A display device token is required');
    }
    const device = await this.prisma.displayDevice.findFirst({
      where: { tokenHash: this.hash(token), type, revokedAt: null },
      select: { id: true, branchId: true, stationId: true },
    });
    if (!device) throw new ForbiddenException('Display device token is invalid or revoked');
    await this.prisma.displayDevice.update({
      where: { id: device.id },
      data: { lastSeenAt: new Date() },
    });
    return device;
  }
}
