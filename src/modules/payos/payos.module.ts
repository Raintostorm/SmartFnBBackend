import { Module } from '@nestjs/common';
import { BranchesModule } from '../branches/branches.module.js';
import { PayosChannelController } from './payos-channel.controller.js';
import { PayosChannelService } from './payos-channel.service.js';
import { PayosCipherService } from './payos-cipher.service.js';
import { PayosApiService } from './payos-api.service.js';
import { PayosPaymentService } from './payos-payment.service.js';
import { PayosWebhookController } from './payos-webhook.controller.js';
import { RealtimeModule } from '../../realtime/realtime.module.js';

@Module({
  imports: [BranchesModule, RealtimeModule],
  controllers: [PayosChannelController, PayosWebhookController],
  providers: [PayosChannelService, PayosCipherService, PayosApiService, PayosPaymentService],
  exports: [PayosChannelService, PayosCipherService, PayosPaymentService],
})
export class PayosModule {}
