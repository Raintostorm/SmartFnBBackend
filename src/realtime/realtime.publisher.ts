import { Injectable } from '@nestjs/common';
import { RealtimeGateway } from './realtime.gateway.js';

@Injectable()
export class RealtimePublisher {
  constructor(private readonly gateway: RealtimeGateway) {}

  branch(branchId: string, type: string, data?: unknown) {
    this.gateway.emitToBranch(branchId, {
      type,
      branchId,
      occurredAt: new Date().toISOString(),
      data,
    });
  }

  chain(chainId: string, type: string, data?: unknown) {
    this.gateway.emitToChain(chainId, {
      type,
      chainId,
      occurredAt: new Date().toISOString(),
      data,
    });
  }

  station(stationId: string, type: string, data?: unknown) {
    this.gateway.emitToStation(stationId, {
      type,
      occurredAt: new Date().toISOString(),
      data,
    });
  }

  callingDisplay(branchId: string, type: string, data?: unknown) {
    this.gateway.emitToCallingDisplay(branchId, {
      type,
      branchId,
      occurredAt: new Date().toISOString(),
      data,
    });
  }
}
