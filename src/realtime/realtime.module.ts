import { Module } from '@nestjs/common';
import { AuthModule } from '../modules/auth/auth.module.js';
import { RealtimeGateway } from './realtime.gateway.js';
import { RealtimePublisher } from './realtime.publisher.js';

@Module({
  imports: [AuthModule],
  providers: [RealtimeGateway, RealtimePublisher],
  exports: [RealtimePublisher],
})
export class RealtimeModule {}
