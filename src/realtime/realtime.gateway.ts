import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  WsException,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { createHash } from 'node:crypto';
import { DisplayDeviceType, PosStationStatus } from '../generated/prisma/client.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../database/prisma.service.js';
import { AuthService } from '../modules/auth/auth.service.js';
import type { AuthenticatedUser } from '../modules/auth/auth.interfaces.js';
import { AppRole } from '../modules/auth/app-role.enum.js';

export interface OperationsEvent {
  type: string;
  branchId?: string;
  chainId?: string;
  occurredAt: string;
  data?: unknown;
}

interface AuthenticatedSocket extends Socket {
  data: {
    user?: AuthenticatedUser;
    device?: { id: string; type: DisplayDeviceType; branchId: string; stationId: string | null };
  };
}

@WebSocketGateway({ namespace: '/operations' })
export class RealtimeGateway implements OnGatewayConnection {
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly authService: AuthService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async handleConnection(client: AuthenticatedSocket) {
    if (!this.config.get<boolean>('REALTIME_ENABLED', true)) {
      client.disconnect(true);
      return;
    }
    try {
      const token = this.extractToken(client);
      const user = await this.authenticateUser(token).catch(() => null);
      if (user) {
        client.data.user = user;
        if (user.branchId) await client.join(this.branchRoom(user.branchId));
        if (user.chainId) await client.join(this.chainRoom(user.chainId));
        for (const chainId of user.chainIds) await client.join(this.chainRoom(chainId));
        client.emit('operations.connected', {
          occurredAt: new Date().toISOString(),
          kind: 'USER',
          branchId: user.branchId,
          chainIds: user.chainIds,
        });
        return;
      }

      const device = await this.authenticateDevice(token);
      client.data.device = device;
      if (device.type === DisplayDeviceType.CUSTOMER_DISPLAY && device.stationId) {
        await client.join(this.stationRoom(device.stationId));
      } else if (device.type === DisplayDeviceType.CALLING_DISPLAY) {
        await client.join(this.callingDisplayRoom(device.branchId));
      }
      client.emit('operations.connected', {
        occurredAt: new Date().toISOString(),
        kind: 'DEVICE',
        deviceType: device.type,
        branchId: device.branchId,
        stationId: device.stationId,
      });
    } catch (error) {
      this.logger.warn(`Rejected realtime connection ${client.id}: ${(error as Error).message}`);
      client.disconnect(true);
    }
  }

  @SubscribeMessage('operations.ping')
  ping(@ConnectedSocket() client: AuthenticatedSocket, @MessageBody() data?: unknown) {
    return { event: 'operations.pong', data: { data, occurredAt: new Date().toISOString() } };
  }

  @SubscribeMessage('cart:update')
  async updateCart(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { stationId?: string; items?: unknown; totalAmount?: unknown },
  ) {
    return this.publishCart(client, data, false);
  }

  @SubscribeMessage('cart:clear')
  async clearCart(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { stationId?: string },
  ) {
    return this.publishCart(client, data, true);
  }

  @SubscribeMessage('display:update')
  async updateDisplay(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { stationId?: string; snapshot?: unknown },
  ) {
    return this.publishDisplay(client, data);
  }

  emitToBranch(branchId: string, event: OperationsEvent) {
    this.server?.to(this.branchRoom(branchId)).emit('operations.updated', event);
  }

  emitToChain(chainId: string, event: OperationsEvent) {
    this.server?.to(this.chainRoom(chainId)).emit('operations.updated', event);
  }

  emitToStation(stationId: string, event: OperationsEvent) {
    this.server?.to(this.stationRoom(stationId)).emit('operations.updated', event);
  }

  emitToCallingDisplay(branchId: string, event: OperationsEvent) {
    this.server?.to(this.callingDisplayRoom(branchId)).emit('operations.updated', event);
  }

  private authenticateUser(token: string) {
    return this.authService.authenticateAccessToken(token);
  }

  private async authenticateDevice(token: string) {
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const device = await this.prisma.displayDevice.findFirst({
      where: { tokenHash, revokedAt: null },
      select: { id: true, type: true, branchId: true, stationId: true },
    });
    if (!device) throw new Error('Device token is invalid or revoked');
    await this.prisma.displayDevice.update({
      where: { id: device.id },
      data: { lastSeenAt: new Date() },
    });
    return device;
  }

  private async publishCart(
    client: AuthenticatedSocket,
    data: { stationId?: string; items?: unknown; totalAmount?: unknown },
    clear: boolean,
  ) {
    const user = client.data.user;
    if (
      !user ||
      user.role !== AppRole.CASHIER ||
      !user.employeeId ||
      !user.branchId ||
      !data?.stationId
    ) {
      throw new WsException('Only an assigned cashier can update a station cart');
    }
    const station = await this.prisma.posStation.findFirst({
      where: {
        id: data.stationId,
        branchId: user.branchId,
        status: PosStationStatus.ACTIVE,
      },
      select: { id: true },
    });
    if (!station) throw new WsException('Active POS station was not found in your branch');

    const snapshot = clear
      ? { state: 'IDLE', items: [], totalAmount: 0 }
      : this.sanitizeSnapshot({ state: 'CART', items: data.items, totalAmount: data.totalAmount });
    const version = await this.prisma.posStation.update({
      where: { id: station.id },
      data: {
        cartVersion: { increment: 1 },
        cartSnapshot: snapshot as Prisma.InputJsonValue,
      },
      select: { cartVersion: true },
    });
    const event: OperationsEvent = {
      type: clear ? 'cart.clear' : 'cart.update',
      branchId: user.branchId,
      occurredAt: new Date().toISOString(),
      data: {
        stationId: station.id,
        version: version.cartVersion,
        ...snapshot,
      },
    };
    this.emitToStation(station.id, event);
    return { event: 'cart.acknowledged', data: event.data };
  }

  private async publishDisplay(
    client: AuthenticatedSocket,
    data: { stationId?: string; snapshot?: unknown },
  ) {
    const user = client.data.user;
    if (
      !user ||
      user.role !== AppRole.CASHIER ||
      !user.employeeId ||
      !user.branchId ||
      !data?.stationId
    ) {
      throw new WsException('Only an assigned cashier can update a customer display');
    }
    const station = await this.prisma.posStation.findFirst({
      where: { id: data.stationId, branchId: user.branchId, status: PosStationStatus.ACTIVE },
      select: { id: true },
    });
    if (!station) throw new WsException('Active POS station was not found in your branch');

    const snapshot = this.sanitizeSnapshot(data.snapshot);
    const version = await this.prisma.posStation.update({
      where: { id: station.id },
      data: { cartVersion: { increment: 1 }, cartSnapshot: snapshot as Prisma.InputJsonValue },
      select: { cartVersion: true },
    });
    const event: OperationsEvent = {
      type: 'display.update',
      branchId: user.branchId,
      occurredAt: new Date().toISOString(),
      data: { stationId: station.id, version: version.cartVersion, ...snapshot },
    };
    this.emitToStation(station.id, event);
    return { event: 'display.acknowledged', data: event.data };
  }

  private sanitizeSnapshot(value: unknown) {
    const input = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    const allowedStates = new Set(['IDLE', 'CART', 'PAYMENT_PENDING', 'PAYMENT_QR', 'PAID']);
    const state =
      typeof input.state === 'string' && allowedStates.has(input.state) ? input.state : 'CART';
    const money = (raw: unknown) => {
      const number = Number(raw);
      return Number.isFinite(number) && number >= 0 ? Math.round(number) : 0;
    };
    const text = (raw: unknown, max: number) =>
      typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, max) : undefined;
    const items = Array.isArray(input.items)
      ? input.items.slice(0, 100).map((raw, index) => {
          const item = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
          const quantity = Math.max(1, Math.min(999, Math.floor(Number(item.quantity) || 1)));
          const options = Array.isArray(item.options)
            ? item.options
                .slice(0, 20)
                .map((option) => text(option, 100))
                .filter(Boolean)
            : [];
          return {
            key: text(item.key, 100) ?? String(index),
            name: text(item.name, 150) ?? 'Món',
            quantity,
            unitPrice: money(item.unitPrice),
            lineTotal: money(item.lineTotal),
            options,
            ...(text(item.note, 500) ? { note: text(item.note, 500) } : {}),
          };
        })
      : [];
    const orderCode = text(input.orderCode, 50);
    const callNumber = Number(input.callNumber);
    const paymentMethod = text(input.paymentMethod, 30);
    const qrCode = text(input.qrCode, 4000);
    const qrExpiresAt = text(input.qrExpiresAt, 50);
    return {
      state,
      items,
      totalAmount: money(input.totalAmount),
      ...(orderCode ? { orderCode } : {}),
      ...(Number.isInteger(callNumber) ? { callNumber } : {}),
      ...(paymentMethod ? { paymentMethod } : {}),
      ...(qrCode ? { qrCode } : {}),
      ...(qrExpiresAt ? { qrExpiresAt } : {}),
    };
  }

  private extractToken(client: Socket) {
    const authToken = client.handshake.auth?.token;
    if (typeof authToken === 'string' && authToken.trim()) return authToken.trim();
    const authorization = client.handshake.headers.authorization;
    const [type, token] = authorization?.trim().split(/\s+/) ?? [];
    if (type?.toLowerCase() === 'bearer' && token) return token;
    throw new Error('Bearer access token is required');
  }

  private branchRoom(branchId: string) {
    return `branch:${branchId}`;
  }

  private stationRoom(stationId: string) {
    return `station:${stationId}`;
  }

  private callingDisplayRoom(branchId: string) {
    return `calling-display:${branchId}`;
  }

  private chainRoom(chainId: string) {
    return `chain:${chainId}`;
  }
}
