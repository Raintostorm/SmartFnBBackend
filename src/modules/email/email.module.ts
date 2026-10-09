import { Module } from '@nestjs/common';
import { EmailOutboxService } from './email-outbox.service.js';

@Module({
  providers: [EmailOutboxService],
  exports: [EmailOutboxService],
})
export class EmailModule {}
