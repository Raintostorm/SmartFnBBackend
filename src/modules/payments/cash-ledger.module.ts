import { Module } from '@nestjs/common';
import { BranchesModule } from '../branches/branches.module.js';
import { CashLedgerController } from './cash-ledger.controller.js';
import { CashLedgerService } from './cash-ledger.service.js';

@Module({
  imports: [BranchesModule],
  controllers: [CashLedgerController],
  providers: [CashLedgerService],
  exports: [CashLedgerService],
})
export class CashLedgerModule {}
