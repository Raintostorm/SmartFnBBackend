import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
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
import { RealtimePublisher } from '../../realtime/realtime.publisher.js';
import type { CreateStationDto, UpdateStationDto } from './dto/station.dto.js';

const DISPLAY_TOKEN_LIFETIME_MS = 30 * 24 * 60 * 60_000;

@Injectable()
export class StationsService {
  private readonly pairingAttempts = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly branchAccess: BranchAccessService,
    private readonly realtime?: RealtimePublisher,
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
    if (!dto.name.trim()) throw new BadRequestException('Station name must not be empty');
    if (dto.printerConnection && dto.printerConnection !== 'NONE' && !dto.printerAddress?.trim())
      throw new BadRequestException('Printer address is required for WiFi or Bluetooth');
    try {
      return await this.prisma.posStation.create({
        data: {
          branchId: actor.branchId,
          name: dto.name.trim(),
          printerConnection: dto.printerConnection,
          printerAddress: dto.printerAddress?.trim(),
        },
      });
    } catch (error) {
      this.rethrowStationConflict(error);
    }
  }

  async update(user: AuthenticatedUser, stationId: string, dto: UpdateStationDto) {
    const actor = this.employee(user);
    await this.branchAccess.assertSubscriptionAllowsWrite(actor.branchId);
    if (!Object.values(dto).some((value) => value !== undefined)) {
      throw new BadRequestException('At least one station field is required');
    }
    const station = await this.prisma.posStation.findFirst({
      where: { id: stationId, branchId: actor.branchId },
      select: { id: true, printerConnection: true, printerAddress: true },
    });
    if (!station) throw new NotFoundException('POS station was not found in your branch');

    const printerConnection = dto.printerConnection ?? station.printerConnection;
    const printerAddress =
      printerConnection === 'NONE'
        ? null
        : dto.printerAddress === undefined
          ? station.printerAddress
          : dto.printerAddress?.trim() || null;
    if (printerConnection !== 'NONE' && !printerAddress) {
      throw new BadRequestException('Printer address is required for WiFi or Bluetooth');
    }
    if (dto.name !== undefined && !dto.name.trim()) {
      throw new BadRequestException('Station name must not be empty');
    }

    try {
      return await this.prisma.posStation.update({
        where: { id: station.id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
          ...(dto.status !== undefined ? { status: dto.status } : {}),
          ...(dto.printerConnection !== undefined ? { printerConnection } : {}),
          ...(dto.printerConnection !== undefined || dto.printerAddress !== undefined
            ? { printerAddress }
            : {}),
        },
      });
    } catch (error) {
      this.rethrowStationConflict(error);
    }
  }

  listDisplayDevices(user: AuthenticatedUser) {
    const actor = this.employee(user);
    return this.prisma.displayDevice.findMany({
      where: { branchId: actor.branchId },
      select: {
        id: true,
        type: true,
        name: true,
        stationId: true,
        station: { select: { id: true, name: true, status: true } },
        pairedAt: true,
        lastSeenAt: true,
        tokenExpiresAt: true,
        revokedAt: true,
      },
      orderBy: { pairedAt: 'desc' },
    });
  }

  async createPairingCode(type: DisplayDeviceType, clientKey = 'unknown') {
    this.assertPairingRateLimit(clientKey);
    await this.prisma.pairingCode.deleteMany?.({
      where: { OR: [{ expiresAt: { lt: new Date() } }, { consumedAt: { not: null } }] },
    });
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

  async callingDisplayContext(authorization?: string) {
    const device = await this.authenticateDisplayDevice(
      authorization,
      DisplayDeviceType.CALLING_DISPLAY,
    );
    const branch = await this.prisma.branch.findUniqueOrThrow({
      where: { id: device.branchId },
      select: {
        name: true,
        timezone: true,
        chain: {
          select: {
            name: true,
            logoUrl: true,
            branding: {
              select: {
                displayName: true,
                logoUrl: true,
                primaryColor: true,
                secondaryColor: true,
                accentColor: true,
              },
            },
          },
        },
      },
    });
    const businessDate = this.businessDate(branch.timezone);
    const baseWhere = {
      branchId: device.branchId,
      businessDate,
      type: OrderType.COUNTER_PICKUP,
      paymentStatus: OrderPaymentStatus.PAID,
    } as const;
    const preparingWhere = {
      ...baseWhere,
      status: { in: [OrderStatus.SUBMITTED, OrderStatus.PREPARING] },
    };
    const readyWhere = { ...baseWhere, status: OrderStatus.READY };
    const [preparing, ready, preparingCount, readyCount] = await this.prisma.$transaction([
      this.prisma.order.findMany({
        where: preparingWhere,
        select: {
          id: true,
          callNumber: true,
          status: true,
          submittedAt: true,
          readyAt: true,
        },
        orderBy: { submittedAt: 'asc' },
        take: 30,
      }),
      this.prisma.order.findMany({
        where: readyWhere,
        select: {
          id: true,
          callNumber: true,
          status: true,
          submittedAt: true,
          readyAt: true,
        },
        orderBy: { readyAt: 'asc' },
        take: 30,
      }),
      this.prisma.order.count({ where: preparingWhere }),
      this.prisma.order.count({ where: readyWhere }),
    ]);
    const branding = branch.chain.branding;
    return {
      branch: { name: branch.name },
      branding: {
        displayName: branding?.displayName ?? branch.chain.name,
        logoUrl: branding?.logoUrl ?? branch.chain.logoUrl,
        primaryColor: branding?.primaryColor ?? '#0F172A',
        secondaryColor: branding?.secondaryColor ?? '#FFFFFF',
        accentColor: branding?.accentColor ?? '#22C55E',
      },
      preparing,
      ready,
      counts: { preparing: preparingCount, ready: readyCount },
      pageLimit: 30,
      serverTime: new Date().toISOString(),
    };
  }

  private businessDate(timezone: string) {
    const date = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    return new Date(`${date}T00:00:00.000Z`);
  }

  async customerDisplayContext(authorization?: string) {
    const device = await this.authenticateDisplayDevice(
      authorization,
      DisplayDeviceType.CUSTOMER_DISPLAY,
    );
    if (!device.stationId)
      throw new ForbiddenException('Customer display is not assigned to a station');

    const station = await this.prisma.posStation.findFirst({
      where: {
        id: device.stationId,
        branchId: device.branchId,
        status: PosStationStatus.ACTIVE,
      },
      select: {
        id: true,
        name: true,
        cartVersion: true,
        cartSnapshot: true,
        branch: {
          select: {
            id: true,
            name: true,
            chain: {
              select: {
                name: true,
                logoUrl: true,
                currency: true,
                displayPosters: {
                  where: { enabled: true, deletedAt: null },
                  orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
                  take: 10,
                  select: { id: true, title: true, imageUrl: true, durationSeconds: true },
                },
                branding: {
                  select: {
                    displayName: true,
                    logoUrl: true,
                    primaryColor: true,
                    secondaryColor: true,
                    accentColor: true,
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!station) throw new NotFoundException('Active station was not found');

    const branding = station.branch.chain.branding;
    return {
      station: { id: station.id, name: station.name },
      branch: { id: station.branch.id, name: station.branch.name },
      currency: station.branch.chain.currency,
      posters: station.branch.chain.displayPosters ?? [],
      branding: {
        displayName: branding?.displayName ?? station.branch.chain.name,
        logoUrl: branding?.logoUrl ?? station.branch.chain.logoUrl,
        primaryColor: branding?.primaryColor ?? '#0F172A',
        secondaryColor: branding?.secondaryColor ?? '#FFFFFF',
        accentColor: branding?.accentColor ?? '#22C55E',
      },
      version: station.cartVersion,
      snapshot: station.cartSnapshot ?? { state: 'IDLE', items: [], totalAmount: 0 },
    };
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
      this.assertPairingCode(pairing, DisplayDeviceType.CUSTOMER_DISPLAY);

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
          tokenExpiresAt: new Date(Date.now() + DISPLAY_TOKEN_LIFETIME_MS),
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
      this.assertPairingCode(pairing, DisplayDeviceType.CALLING_DISPLAY);

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
          tokenExpiresAt: new Date(Date.now() + DISPLAY_TOKEN_LIFETIME_MS),
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
    await this.realtime?.revokeDevice(deviceId);
    return { revoked: true };
  }

  private hash(value: string) {
    return createHash('sha256').update(value).digest('hex');
  }

  private rethrowStationConflict(error: unknown): never {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new ConflictException({
        code: 'STATION_NAME_ALREADY_EXISTS',
        message: 'A station with this name already exists in the branch',
      });
    }
    throw error;
  }

  private assertPairingCode(
    pairing: {
      deviceTokenHash: string | null;
      deviceType: DisplayDeviceType;
      consumedAt: Date | null;
      expiresAt: Date;
    } | null,
    expectedType: DisplayDeviceType,
  ): asserts pairing is NonNullable<typeof pairing> & { deviceTokenHash: string } {
    if (!pairing || !pairing.deviceTokenHash || pairing.deviceType !== expectedType) {
      throw new BadRequestException({
        code: 'PAIRING_CODE_INVALID',
        message: 'Pairing code is invalid',
      });
    }
    if (pairing.consumedAt) {
      throw new BadRequestException({
        code: 'PAIRING_CODE_USED',
        message: 'Pairing code was used',
      });
    }
    if (pairing.expiresAt <= new Date()) {
      throw new BadRequestException({
        code: 'PAIRING_CODE_EXPIRED',
        message: 'Pairing code has expired',
      });
    }
  }

  private assertPairingRateLimit(key: string) {
    const now = Date.now();
    const current = this.pairingAttempts.get(key);
    if (!current || current.resetAt <= now) {
      this.pairingAttempts.set(key, { count: 1, resetAt: now + 60_000 });
      return;
    }
    current.count += 1;
    if (current.count > 10) throw new HttpException('Too many pairing code requests', 429);
    if (this.pairingAttempts.size > 10_000) {
      for (const [entry, value] of this.pairingAttempts)
        if (value.resetAt <= now) this.pairingAttempts.delete(entry);
    }
  }

  private async authenticateDisplayDevice(
    authorization: string | undefined,
    type: DisplayDeviceType,
  ) {
    const [scheme, token] = authorization?.trim().split(/\s+/) ?? [];
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      throw new ForbiddenException({
        code: 'DEVICE_TOKEN_MISSING',
        message: 'A display device token is required',
      });
    }
    const device = await this.prisma.displayDevice.findFirst({
      where: { tokenHash: this.hash(token), type },
      select: {
        id: true,
        branchId: true,
        stationId: true,
        revokedAt: true,
        tokenExpiresAt: true,
      },
    });
    if (!device) {
      throw new ForbiddenException({
        code: 'DEVICE_TOKEN_INVALID',
        message: 'Display device token is invalid',
      });
    }
    if (device.revokedAt) {
      throw new ForbiddenException({
        code: 'DEVICE_TOKEN_REVOKED',
        message: 'Display device token has been revoked',
      });
    }
    if (device.tokenExpiresAt <= new Date()) {
      throw new ForbiddenException({
        code: 'DEVICE_TOKEN_EXPIRED',
        message: 'Display device token has expired',
      });
    }
    await this.prisma.displayDevice.update({
      where: { id: device.id },
      data: { lastSeenAt: new Date() },
    });
    return { id: device.id, branchId: device.branchId, stationId: device.stationId };
  }
}
