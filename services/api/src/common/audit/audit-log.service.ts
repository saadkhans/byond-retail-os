import { Injectable } from '@nestjs/common';
import { AuditAction, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

export const SYSTEM_ACTOR_EMAIL = 'system@byond.internal';

// Denylist applied recursively to before/after snapshots. Audit rows outlive
// normal data-retention paths, so sensitive material must never enter them.
// Keys are reduced to lowercase alphanumerics before comparison, so every
// separator style matches: api_key, access-token, access:token,
// refresh/token, credit_card_number, "Card Number", secret.key, ...
const REDACTED_FIELDS = new Set([
  'password',
  'passwordhash',
  'secret',
  'secretkey',
  'clientsecret',
  'privatekey',
  'token',
  'accesstoken',
  'refreshtoken',
  'sessiontoken',
  'idtoken',
  'bearer',
  'bearertoken',
  'apikey',
  'authorization',
  'cardnumber',
  'creditcard',
  'creditcardnumber',
  'cvv',
  'cvc',
  'pan',
  'pin',
  'iban',
]);

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
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
        if (REDACTED_FIELDS.has(normalizeKey(key))) {
          result[key] = '[REDACTED]';
        } else {
          result[key] = this.redact(val);
        }
      }
      return result;
    }
    return value;
  }
}
