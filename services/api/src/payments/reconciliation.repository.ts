import { Injectable } from '@nestjs/common';
import {
  PaymentReconciliationRecord,
  Prisma,
  ReconciliationStatus,
} from '@prisma/client';
import {
  AuditEntry,
  AuditLogService,
} from '../common/audit/audit-log.service';
import { PrismaService } from '../prisma/prisma.service';
import { TenantScopedRepository } from '../prisma/tenant-scoped.repository';

export const RECONCILIATION_INCLUDE = {
  intent: {
    select: { id: true, status: true, provider: true, orderId: true },
  },
} satisfies Prisma.PaymentReconciliationRecordInclude;

export type ReconciliationWithRefs =
  Prisma.PaymentReconciliationRecordGetPayload<{
    include: typeof RECONCILIATION_INCLUDE;
  }>;

/** RECONCILED is a terminal reconciliation state — it never changes again. */
export type ReconciliationUpdateRejection = 'terminal-blocked';

@Injectable()
export class ReconciliationRepository extends TenantScopedRepository {
  constructor(
    prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {
    super(prisma);
  }

  findById(
    tenantId: string,
    id: string,
  ): Promise<ReconciliationWithRefs | null> {
    return this.prisma.paymentReconciliationRecord.findFirst({
      where: this.scope(tenantId, { id }),
      include: RECONCILIATION_INCLUDE,
    });
  }

  async search(
    tenantId: string,
    filters: {
      status?: ReconciliationStatus;
      intentId?: string;
      skip?: number;
      take?: number;
    },
  ): Promise<{ items: ReconciliationWithRefs[]; total: number }> {
    const where: Prisma.PaymentReconciliationRecordWhereInput =
      this.scope(tenantId);
    if (filters.status) {
      where.status = filters.status;
    }
    if (filters.intentId) {
      where.intentId = filters.intentId;
    }
    const [items, total] = await Promise.all([
      this.prisma.paymentReconciliationRecord.findMany({
        where,
        include: RECONCILIATION_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: filters.skip ?? 0,
        take: filters.take ?? 25,
      }),
      this.prisma.paymentReconciliationRecord.count({ where }),
    ]);
    return { items, total };
  }

  /**
   * Manual reconciliation status update (no settlement accounting, no provider
   * import in Phase 6). Terminal-protected: a RECONCILED record never changes
   * again. Setting RECONCILED stamps reconciledAt.
   */
  updateStatus(
    tenantId: string,
    id: string,
    input: {
      status: ReconciliationStatus;
      reportedAmountMinor?: number;
      notes?: string;
    },
    buildAuditEntry: (
      before: PaymentReconciliationRecord,
      after: ReconciliationWithRefs,
    ) => AuditEntry,
  ): Promise<
    ReconciliationWithRefs | ReconciliationUpdateRejection | null
  > {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.paymentReconciliationRecord.findFirst({
        where: { id, tenantId: scopedTenantId },
      });
      if (!before) {
        return null;
      }
      if (before.status === ReconciliationStatus.RECONCILED) {
        return 'terminal-blocked' as const;
      }
      // CONDITIONAL update: the `status: { not: RECONCILED }` guard makes this
      // race-safe under concurrent PATCHes. If another request reconciled the
      // record between our read and this write, the update matches zero rows
      // and we report a controlled conflict instead of moving it OUT of the
      // terminal RECONCILED state.
      const updated = await tx.paymentReconciliationRecord.updateMany({
        where: {
          id: before.id,
          tenantId: scopedTenantId,
          status: { not: ReconciliationStatus.RECONCILED },
        },
        data: {
          status: input.status,
          reportedAmountMinor: input.reportedAmountMinor,
          notes: input.notes,
          reconciledAt:
            input.status === ReconciliationStatus.RECONCILED
              ? new Date()
              : before.reconciledAt,
        },
      });
      if (updated.count === 0) {
        return 'terminal-blocked' as const;
      }
      const after = await tx.paymentReconciliationRecord.findFirstOrThrow({
        where: { id: before.id, tenantId: scopedTenantId },
        include: RECONCILIATION_INCLUDE,
      });
      await this.auditLog.record(buildAuditEntry(before, after), tx);
      return after;
    });
  }
}
