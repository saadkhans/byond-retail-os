import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction } from '@prisma/client';
import {
  AuditActor,
  AuditEntry,
  SYSTEM_ACTOR_EMAIL,
} from '../common/audit/audit-log.service';
import { assertSafePaymentStrings } from './payment-sanitization';
import {
  ReconciliationRepository,
  ReconciliationWithRefs,
} from './reconciliation.repository';
import { QueryReconciliationDto } from './dto/query-reconciliation.dto';
import { UpdateReconciliationDto } from './dto/update-reconciliation.dto';

@Injectable()
export class ReconciliationService {
  constructor(private readonly repository: ReconciliationRepository) {}

  async findById(
    tenantId: string,
    id: string,
  ): Promise<ReconciliationWithRefs> {
    const record = await this.repository.findById(tenantId, id);
    if (!record) {
      throw new NotFoundException(
        `Reconciliation record "${id}" not found`,
      );
    }
    return record;
  }

  async search(
    tenantId: string,
    query: QueryReconciliationDto,
  ): Promise<{
    items: ReconciliationWithRefs[];
    total: number;
    skip: number;
    take: number;
  }> {
    const skip = query.skip ?? 0;
    const take = query.take ?? 25;
    const { items, total } = await this.repository.search(tenantId, {
      status: query.status,
      intentId: query.intentId,
      skip,
      take,
    });
    return { items, total, skip, take };
  }

  async updateStatus(
    tenantId: string,
    id: string,
    dto: UpdateReconciliationDto,
    actor?: AuditActor,
  ): Promise<ReconciliationWithRefs> {
    const notes = dto.notes?.trim() || undefined;
    assertSafePaymentStrings({ notes });
    const result = await this.repository.updateStatus(
      tenantId,
      id,
      {
        status: dto.status,
        reportedAmountMinor: dto.reportedAmountMinor,
        notes,
      },
      (before, after) =>
        this.auditEntry(tenantId, actor, {
          action: AuditAction.RECONCILE,
          entityType: 'PaymentReconciliationRecord',
          entityId: after.id,
          before,
          after,
          reason: notes ?? `Reconciliation status → ${dto.status}`,
        }),
    );
    if (result === null) {
      throw new NotFoundException(
        `Reconciliation record "${id}" not found`,
      );
    }
    if (result === 'terminal-blocked') {
      throw new ConflictException(
        'Reconciliation record is RECONCILED (terminal) and cannot change again',
      );
    }
    return result;
  }

  private auditEntry(
    tenantId: string,
    actor: AuditActor | undefined,
    partial: Pick<
      AuditEntry,
      'action' | 'entityType' | 'entityId' | 'before' | 'after' | 'reason'
    >,
  ): AuditEntry {
    return {
      tenantId,
      actorId: actor?.id ?? null,
      actorEmail: actor?.email ?? SYSTEM_ACTOR_EMAIL,
      ...partial,
    };
  }
}
