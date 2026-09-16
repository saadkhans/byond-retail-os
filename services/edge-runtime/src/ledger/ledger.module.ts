import { Module } from '@nestjs/common';
import { LocalLedgerService } from './local-ledger.service';

@Module({
  providers: [LocalLedgerService],
  exports: [LocalLedgerService],
})
export class LedgerModule {}
