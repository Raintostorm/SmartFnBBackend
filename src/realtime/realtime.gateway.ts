import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { AuthService } from '../modules/auth/auth.service.js';
import type { AuthenticatedUser } from '../modules/auth/auth.interfaces.js';

export interface OperationsEvent {
  type: string;
  branchId?: string;
  chainId?: string;
  occurredAt: string;
  data?: unknown;
}

interface AuthenticatedSocket extends Socket {
  data: { user?: AuthenticatedUser };
}

@WebSocketGateway({ namespace: '/operations' })
export class RealtimeGateway implements OnGatewayConnection {
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly authService: AuthService,
    private readonly config: ConfigService,
  ) {}

  async handleConnection(client: AuthenticatedSocket) {
    if (!this.config.get<boolean>('REALTIME_ENABLED', true)) {
      client.disconnect(true);
      return;
    }
    try {
      const token = this.extractToken(client);
      const user = await this.authService.authenticateAccessToken(token);
      client.data.user = user;
      if (user.branchId) await client.join(this.branchRoom(user.branchId));
      if (user.chainId) await client.join(this.chainRoom(user.chainId));
      for (const chainId of user.chainIds) await client.join(this.chainRoom(chainId));
      client.emit('operations.connected', {
        occurredAt: new Date().toISOString(),
        branchId: user.branchId,
        chainIds: user.chainIds,
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

  emitToBranch(branchId: string, event: OperationsEvent) {
    this.server?.to(this.branchRoom(branchId)).emit('operations.updated', event);
  }

  emitToChain(chainId: string, event: OperationsEvent) {
    this.server?.to(this.chainRoom(chainId)).emit('operations.updated', event);
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

  private chainRoom(chainId: string) {
    return `chain:${chainId}`;
  }
}
