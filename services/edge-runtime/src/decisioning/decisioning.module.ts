import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { SyncModule } from '../sync/sync.module';
import { OfflineDecisionService } from './offline-decision.service';
import { ReviewQueueService } from './review-queue.service';

@Module({
  imports: [LedgerModule, SyncModule],
  providers: [OfflineDecisionService, ReviewQueueService],
  exports: [OfflineDecisionService, ReviewQueueService],
})
export class DecisioningModule {}
