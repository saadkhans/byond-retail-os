import { Injectable } from '@nestjs/common';
import { AuditAction, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  containsSensitiveValue,
  isSensitiveKey,
} from '../sensitive-keys';

export const SYSTEM_ACTOR_EMAIL = 'system@byond.internal';

// Redaction rules applied recursively to before/after snapshots. Audit rows
// outlive normal data-retention paths, so sensitive material must never enter
// them. The credential/payment-shaped key heuristics live in
// common/sensitive-keys.ts, SHARED with device-metadata validation so the
// two policies cannot drift.

/** Authenticated actor attribution for audited mutations. */
export interface AuditActor {
  id: string;
  email: string;
}

export interface AuditEntry {
  tenantId: string | null;
  actorId?: string | null;
  actorEmail: string;
  action: AuditAction;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string;
  ipAddress?: string;
  userAgent?: string;
  requestId?: string;
}

@Injectable()
export class AuditLogService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Append an audit record. Intentionally NOT fire-and-forget: if the audit
   * write fails, the calling state change must fail with it (fail closed).
   *
   * Pass the surrounding Prisma transaction client as `tx` so the audit row
   * commits or rolls back atomically with the mutation it describes —
   * repositories performing audited mutations must always do this.
   *
   * There are no update/delete methods on this service by design.
   */
  async record(
    entry: AuditEntry,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const client = tx ?? this.prisma;
    await client.auditLog.create({
      data: {
        tenantId: entry.tenantId,
        actorId: entry.actorId ?? null,
        actorEmail: entry.actorEmail,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        before: this.toJson(entry.before),
        after: this.toJson(entry.after),
        reason: entry.reason,
        ipAddress: entry.ipAddress,
        userAgent: entry.userAgent,
        requestId: entry.requestId,
      },
    });
  }

  private toJson(
    value: unknown,
  ): Prisma.InputJsonValue | typeof Prisma.JsonNull | undefined {
    if (value === undefined) {
      return undefined;
    }
    if (value === null) {
      return Prisma.JsonNull;
    }
    return this.redact(value) as Prisma.InputJsonValue;
  }

  private redact(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.redact(item));
    }
    if (value instanceof Date) {
      return value.toISOString();
    }
    if (value !== null && typeof value === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value)) {
        if (isSensitiveKey(key)) {
          result[key] = '[REDACTED]';
        } else {
          result[key] = this.redact(val);
        }
      }
      return result;
    }
    // Credential- or PAN-bearing string VALUES (rtsp://user:pass@host,
    // ?access_token=... URLs, password=x connection strings, raw card
    // numbers) are redacted even under a harmless key — same shared
    // detection that blocks device-metadata persistence.
    if (typeof value === 'string' && containsSensitiveValue(value)) {
      return '[REDACTED]';
    }
    return value;
  }
}
