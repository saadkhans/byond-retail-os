import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  PriceBook,
  PriceBookStatus,
  PriceBookVersion,
  PriceChangeReason,
} from '@prisma/client';
import {
  AuditActor,
  AuditEntry,
  SYSTEM_ACTOR_EMAIL,
} from '../common/audit/audit-log.service';
import { containsSensitiveFreeText } from '../video-ingest/media-safety';
import { ActivateVersionDto } from './dto/activate-version.dto';
import { CreatePriceBookDto } from './dto/create-price-book.dto';
import { CreateVersionDto } from './dto/create-version.dto';
import {
  QueryPriceBooksDto,
  ResolvePriceDto,
} from './dto/query-pricing.dto';
import { RollbackVersionDto } from './dto/rollback-version.dto';
import { SetEntriesDto } from './dto/set-entries.dto';
import { UpdatePriceBookDto } from './dto/update-price-book.dto';
import {
  normalizeCurrencyCode,
  normalizePriceBookCode,
  ResolvedPrice,
} from './pricing.logic';
import { PriceActivationHub } from './price-activation.hub';
import { PriceResolutionService } from './price-resolution.service';
import {
  PriceBookDetail,
  PriceBookEntryWithProduct,
  PriceBookVersionSummary,
  PricingRepository,
  VersionRejection,
} from './pricing.repository';

/**
 * A price-change note is persisted on the version AND copied into
 * AuditLog.reason, which audit redaction does not cover. Screen it with the
 * strict free-text predicate for the same reason the inventory ledger does:
 * a pasted PAN or credential in a justification field would be retained
 * forever (AGENTS.md payments invariant).
 */
function assertSafeNote(value: string): void {
  if (containsSensitiveFreeText(value)) {
    throw new BadRequestException(
      'note must not contain credential- or payment-bearing values',
    );
  }
}

/** Caller-supplied ids echoed into errors land in logs — redact unsafe ones. */
function safeErrorEntityId(id: string): string {
  return containsSensitiveFreeText(id) ? '[REDACTED]' : id;
}

@Injectable()
export class PricingService {
  constructor(
    private readonly repository: PricingRepository,
    private readonly resolution: PriceResolutionService,
    private readonly activationHub: PriceActivationHub,
  ) {}

  // ---------------------------------------------------------------- books

  async createBook(
    tenantId: string,
    dto: CreatePriceBookDto,
    actor: AuditActor,
  ): Promise<PriceBook> {
    const code = normalizePriceBookCode(dto.code);
    const currencyCode = normalizeCurrencyCode(dto.currencyCode);
    const result = await this.repository.createBook(
      tenantId,
      {
        code,
        name: dto.name.trim(),
        currencyCode,
        locationId: dto.locationId,
        createdById: actor.id,
      },
      (book) =>
        this.audit(tenantId, actor, {
          action: AuditAction.CREATE,
          entityType: 'PriceBook',
          entityId: book.id,
          after: book,
          reason: `Price book ${book.code} created`,
        }),
    );
    if (result === 'code-taken') {
      throw new ConflictException(
        `A price book with code "${code}" already exists in this tenant`,
      );
    }
    if (result === 'location-not-found') {
      throw new NotFoundException(
        `Location "${safeErrorEntityId(dto.locationId ?? '')}" not found`,
      );
    }
    return result;
  }

  findBooks(
    tenantId: string,
    query: QueryPriceBooksDto,
  ): Promise<{ items: PriceBookDetail[]; total: number }> {
    return this.repository.findBooks(tenantId, {
      locationId: query.locationId,
      status: query.status as PriceBookStatus | undefined,
      skip: query.skip,
      take: query.take,
    });
  }

  async findBookById(tenantId: string, id: string): Promise<PriceBookDetail> {
    const book = await this.repository.findBookById(tenantId, id);
    if (!book) {
      throw new NotFoundException(
        `Price book "${safeErrorEntityId(id)}" not found`,
      );
    }
    return book;
  }

  async updateBook(
    tenantId: string,
    id: string,
    dto: UpdatePriceBookDto,
    actor: AuditActor,
  ): Promise<PriceBook> {
    if (dto.name === undefined && dto.status === undefined) {
      throw new BadRequestException('Provide a name and/or a status to change');
    }
    const result = await this.repository.updateBook(
      tenantId,
      id,
      {
        name: dto.name?.trim(),
        status: dto.status as PriceBookStatus | undefined,
      },
      (before, after) =>
        this.audit(tenantId, actor, {
          action: AuditAction.UPDATE,
          entityType: 'PriceBook',
          entityId: after.id,
          before,
          after,
          reason: `Price book ${after.code} updated`,
        }),
    );
    if (result === 'book-not-found') {
      throw new NotFoundException(
        `Price book "${safeErrorEntityId(id)}" not found`,
      );
    }
    return result;
  }

  // ------------------------------------------------------------- versions

  async createVersion(
    tenantId: string,
    bookId: string,
    dto: CreateVersionDto,
    actor: AuditActor,
  ): Promise<PriceBookVersion> {
    const note = dto.note?.trim();
    if (note) {
      assertSafeNote(note);
    }
    const effectiveFrom = this.parseInstant(dto.effectiveFrom) ?? new Date();
    const result = await this.repository.createVersion(
      tenantId,
      bookId,
      {
        reason: (dto.reason ?? 'PRICE_CHANGE') as PriceChangeReason,
        note,
        effectiveFrom,
        copyFromVersionId: dto.copyFromVersionId,
        createdById: actor.id,
      },
      (version) =>
        this.audit(tenantId, actor, {
          action: AuditAction.CREATE,
          entityType: 'PriceBookVersion',
          entityId: version.id,
          after: version,
          reason:
            note ??
            `Draft price version ${version.versionNumber} created`,
        }),
    );
    return this.unwrapVersion(result, bookId);
  }

  async findVersion(
    tenantId: string,
    bookId: string,
    versionId: string,
  ): Promise<PriceBookVersionSummary> {
    const version = await this.repository.findVersion(
      tenantId,
      bookId,
      versionId,
    );
    if (!version) {
      throw new NotFoundException(
        `Price book version "${safeErrorEntityId(versionId)}" not found`,
      );
    }
    return version;
  }

  async findEntries(
    tenantId: string,
    bookId: string,
    versionId: string,
  ): Promise<PriceBookEntryWithProduct[]> {
    const entries = await this.repository.findEntries(
      tenantId,
      bookId,
      versionId,
    );
    if (entries === 'version-not-found') {
      throw new NotFoundException(
        `Price book version "${safeErrorEntityId(versionId)}" not found`,
      );
    }
    return entries;
  }

  async setEntries(
    tenantId: string,
    bookId: string,
    versionId: string,
    dto: SetEntriesDto,
    actor: AuditActor,
  ): Promise<PriceBookVersion> {
    const seen = new Set<string>();
    for (const entry of dto.entries) {
      if (seen.has(entry.productId)) {
        throw new BadRequestException(
          'entries must list each product at most once',
        );
      }
      seen.add(entry.productId);
    }
    const result = await this.repository.setEntries(
      tenantId,
      bookId,
      versionId,
      dto.entries,
      (version, count) =>
        this.audit(tenantId, actor, {
          action: AuditAction.UPDATE,
          entityType: 'PriceBookVersion',
          entityId: version.id,
          after: { versionId: version.id, entryCount: count },
          reason: `Draft price version ${version.versionNumber} entries replaced (${count})`,
        }),
    );
    return this.unwrapVersion(result, bookId);
  }

  /**
   * Activation is the moment prices actually change for shoppers, which is
   * why it is audited as PRICE_CHANGE rather than a generic UPDATE.
   */
  async activateVersion(
    tenantId: string,
    bookId: string,
    versionId: string,
    dto: ActivateVersionDto,
    actor: AuditActor,
  ): Promise<PriceBookVersion> {
    const note = dto.note?.trim();
    if (note) {
      assertSafeNote(note);
    }
    const effectiveFrom = this.parseInstant(dto.effectiveFrom) ?? new Date();
    const result = await this.repository.activateVersion(
      tenantId,
      bookId,
      versionId,
      { effectiveFrom, note, activatedById: actor.id },
      {
        activated: (before, after) =>
          this.audit(tenantId, actor, {
            action: AuditAction.PRICE_CHANGE,
            entityType: 'PriceBookVersion',
            entityId: after.id,
            before,
            after,
            reason:
              note ??
              `Price version ${after.versionNumber} activated`,
          }),
        superseded: (before, after) =>
          this.audit(tenantId, actor, {
            action: AuditAction.UPDATE,
            entityType: 'PriceBookVersion',
            entityId: after.id,
            before,
            after,
            reason: `Price version ${after.versionNumber} superseded`,
          }),
      },
    );
    const activated = this.unwrapVersion(result, bookId);
    await this.announceActivation(tenantId, bookId, activated.id);
    return activated;
  }

  /**
   * Reversibility without rewriting: rollback creates a NEW version carrying
   * the old prices and activates it, so the history reads forward.
   */
  async rollbackToVersion(
    tenantId: string,
    bookId: string,
    versionId: string,
    dto: RollbackVersionDto,
    actor: AuditActor,
  ): Promise<PriceBookVersion> {
    const note = dto.note?.trim();
    if (note) {
      assertSafeNote(note);
    }
    const result = await this.repository.rollbackToVersion(
      tenantId,
      bookId,
      versionId,
      { note, actorId: actor.id, at: new Date() },
      {
        created: (version) =>
          this.audit(tenantId, actor, {
            action: AuditAction.ROLLBACK,
            entityType: 'PriceBookVersion',
            entityId: version.id,
            after: version,
            reason:
              note ??
              `Price version ${version.versionNumber} created by rolling back to ${versionId}`,
          }),
        activated: (before, after) =>
          this.audit(tenantId, actor, {
            action: AuditAction.PRICE_CHANGE,
            entityType: 'PriceBookVersion',
            entityId: after.id,
            before,
            after,
            reason: `Rollback version ${after.versionNumber} activated`,
          }),
        superseded: (before, after) =>
          this.audit(tenantId, actor, {
            action: AuditAction.UPDATE,
            entityType: 'PriceBookVersion',
            entityId: after.id,
            before,
            after,
            reason: `Price version ${after.versionNumber} superseded by rollback`,
          }),
      },
    );
    const activated = this.unwrapVersion(result, bookId);
    // A rollback IS an activation — shopper-visible prices just changed, so
    // subscribers must hear about it exactly as they would for a forward
    // change. Forgetting this is how a rolled-back price stays on a shelf.
    await this.announceActivation(tenantId, bookId, activated.id);
    return activated;
  }

  /**
   * Tells subscribers that a version is now in force. Runs AFTER the
   * activation transaction has committed, so a listener can never observe a
   * price that was rolled back — and the hub isolates listener failures, so a
   * subscriber can never fail the price change.
   */
  private async announceActivation(
    tenantId: string,
    bookId: string,
    versionId: string,
  ): Promise<void> {
    const facts = await this.repository.findActivationFacts(
      tenantId,
      bookId,
      versionId,
    );
    if (!facts) {
      return;
    }
    await this.activationHub.publish({
      tenantId,
      priceBookId: bookId,
      priceBookVersionId: versionId,
      locationId: facts.locationId,
      productIds: facts.productIds,
    });
  }

  // ------------------------------------------------------------ resolution

  async resolve(
    tenantId: string,
    query: ResolvePriceDto,
  ): Promise<ResolvedPrice | null> {
    const at = this.parseInstant(query.at) ?? new Date();
    return this.resolution.resolve(
      tenantId,
      query.productId,
      at,
      query.locationId,
    );
  }

  // --------------------------------------------------------------- helpers

  private parseInstant(raw?: string): Date | undefined {
    if (raw === undefined) {
      return undefined;
    }
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException('Timestamps must be valid ISO-8601');
    }
    return parsed;
  }

  private audit(
    tenantId: string,
    actor: AuditActor,
    entry: Omit<AuditEntry, 'tenantId' | 'actorId' | 'actorEmail'>,
  ): AuditEntry {
    return {
      ...entry,
      tenantId,
      actorId: actor.id,
      actorEmail: actor.email || SYSTEM_ACTOR_EMAIL,
    };
  }

  private unwrapVersion(
    result: PriceBookVersion | VersionRejection,
    bookId: string,
  ): PriceBookVersion {
    if (typeof result !== 'string') {
      return result;
    }
    switch (result) {
      case 'book-not-found':
        throw new NotFoundException(
          `Price book "${safeErrorEntityId(bookId)}" not found`,
        );
      case 'version-not-found':
      case 'copy-source-not-found':
        throw new NotFoundException('Price book version not found');
      case 'book-archived':
        throw new ConflictException(
          'An ARCHIVED price book cannot be changed',
        );
      case 'version-not-draft':
        throw new ConflictException(
          'Entries of a version that has been activated are immutable — ' +
            'create a new version instead',
        );
      case 'version-not-activatable':
        throw new ConflictException(
          'Only a DRAFT version can be activated',
        );
      case 'version-empty':
        throw new ConflictException(
          'A version with no entries cannot be activated — it would leave ' +
            'the book with no prices',
        );
      case 'source-version-not-resolvable':
        throw new ConflictException(
          'Only a version that has actually been active can be rolled back to',
        );
      case 'effective-from-not-after-active':
        throw new ConflictException(
          'effectiveFrom must be strictly after the currently active ' +
            'version’s effectiveFrom',
        );
      case 'product-not-found':
        throw new NotFoundException(
          'One or more products in the entry set do not exist in this tenant',
        );
      default: {
        const exhaustive: never = result;
        throw new ConflictException(`Price change rejected: ${exhaustive}`);
      }
    }
  }
}
