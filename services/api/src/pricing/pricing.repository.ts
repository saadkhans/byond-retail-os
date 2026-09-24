import { Injectable } from '@nestjs/common';
import {
  PriceBook,
  PriceBookEntry,
  PriceBookStatus,
  PriceBookVersion,
  PriceBookVersionStatus,
  PriceChangeReason,
  Prisma,
} from '@prisma/client';
import { AuditEntry, AuditLogService } from '../common/audit/audit-log.service';
import { PrismaService } from '../prisma/prisma.service';
import { TenantScopedRepository } from '../prisma/tenant-scoped.repository';
import { PriceCandidate } from './pricing.logic';

/** Statuses a version must be in to resolve a price (see pricing.logic.ts). */
const RESOLVABLE: PriceBookVersionStatus[] = [
  PriceBookVersionStatus.ACTIVE,
  PriceBookVersionStatus.SUPERSEDED,
];

export const VERSION_SUMMARY_SELECT = {
  id: true,
  priceBookId: true,
  versionNumber: true,
  status: true,
  effectiveFrom: true,
  effectiveTo: true,
  reason: true,
  note: true,
  activatedAt: true,
  activatedById: true,
  createdById: true,
  supersededByVersionId: true,
  rolledBackFromVersionId: true,
  createdAt: true,
} satisfies Prisma.PriceBookVersionSelect;

export type PriceBookVersionSummary = Prisma.PriceBookVersionGetPayload<{
  select: typeof VERSION_SUMMARY_SELECT;
}>;

export const BOOK_DETAIL_INCLUDE = {
  location: { select: { id: true, code: true, name: true } },
  versions: {
    select: VERSION_SUMMARY_SELECT,
    orderBy: { versionNumber: 'desc' },
  },
} satisfies Prisma.PriceBookInclude;

export type PriceBookDetail = Prisma.PriceBookGetPayload<{
  include: typeof BOOK_DETAIL_INCLUDE;
}>;

export type PriceBookEntryWithProduct = Prisma.PriceBookEntryGetPayload<{
  include: { product: { select: { id: true; sku: true; name: true } } };
}>;

export type CreateBookRejection = 'code-taken' | 'location-not-found';

export type VersionRejection =
  | 'book-not-found'
  | 'book-archived'
  | 'version-not-found'
  | 'version-not-draft'
  | 'version-empty'
  | 'version-not-activatable'
  | 'source-version-not-resolvable'
  | 'effective-from-not-after-active'
  | 'product-not-found'
  | 'copy-source-not-found';

export interface ActivationAuditBuilders {
  activated: (before: PriceBookVersion, after: PriceBookVersion) => AuditEntry;
  superseded?: (
    before: PriceBookVersion,
    after: PriceBookVersion,
  ) => AuditEntry;
}

export interface RollbackAuditBuilders extends ActivationAuditBuilders {
  created: (version: PriceBookVersion) => AuditEntry;
}

/**
 * Data access for price books. Every method takes `tenantId` first and scopes
 * every query with it (AGENTS.md tenancy invariant); nothing here can be
 * called in a way that reads across tenants.
 *
 * Mutation shape follows the inventory ledger's: the row change and its audit
 * entry share ONE transaction, so an audited price change is never recorded
 * without the change, nor the change without the record.
 */
@Injectable()
export class PricingRepository extends TenantScopedRepository {
  constructor(
    prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {
    super(prisma);
  }

  // ---------------------------------------------------------------- books

  createBook(
    tenantId: string,
    data: {
      code: string;
      name: string;
      currencyCode: string;
      locationId?: string;
      createdById?: string;
    },
    buildAuditEntry: (book: PriceBook) => AuditEntry,
  ): Promise<PriceBook | CreateBookRejection> {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      if (data.locationId) {
        const location = await tx.location.findFirst({
          where: { id: data.locationId, tenantId: scopedTenantId },
          select: { id: true },
        });
        if (!location) {
          return 'location-not-found' as const;
        }
      }
      const clash = await tx.priceBook.findFirst({
        where: { tenantId: scopedTenantId, code: data.code },
        select: { id: true },
      });
      if (clash) {
        return 'code-taken' as const;
      }
      const book = await tx.priceBook.create({
        data: {
          tenantId: scopedTenantId,
          code: data.code,
          name: data.name,
          currencyCode: data.currencyCode,
          locationId: data.locationId ?? null,
          createdById: data.createdById,
        },
      });
      await this.auditLog.record(buildAuditEntry(book), tx);
      return book;
    });
  }

  async findBooks(
    tenantId: string,
    query: {
      locationId?: string;
      status?: PriceBookStatus;
      skip?: number;
      take?: number;
    },
  ): Promise<{ items: PriceBookDetail[]; total: number }> {
    const where = this.scope(tenantId, {
      ...(query.locationId ? { locationId: query.locationId } : {}),
      ...(query.status ? { status: query.status } : {}),
    });
    const [items, total] = await Promise.all([
      this.prisma.priceBook.findMany({
        where,
        include: BOOK_DETAIL_INCLUDE,
        orderBy: [{ code: 'asc' }],
        skip: query.skip ?? 0,
        take: query.take ?? 50,
      }),
      this.prisma.priceBook.count({ where }),
    ]);
    return { items, total };
  }

  findBookById(tenantId: string, id: string): Promise<PriceBookDetail | null> {
    return this.prisma.priceBook.findFirst({
      where: this.scope(tenantId, { id }),
      include: BOOK_DETAIL_INCLUDE,
    });
  }

  updateBook(
    tenantId: string,
    id: string,
    data: { name?: string; status?: PriceBookStatus },
    buildAuditEntry: (before: PriceBook, after: PriceBook) => AuditEntry,
  ): Promise<PriceBook | 'book-not-found'> {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.priceBook.findFirst({
        where: { id, tenantId: scopedTenantId },
      });
      if (!before) {
        return 'book-not-found' as const;
      }
      const after = await tx.priceBook.update({
        where: { id_tenantId: { id: before.id, tenantId: scopedTenantId } },
        data: { name: data.name, status: data.status },
      });
      await this.auditLog.record(buildAuditEntry(before, after), tx);
      return after;
    });
  }

  // ------------------------------------------------------------- versions

  /**
   * Creates a DRAFT version. Drafts are the only mutable thing in pricing:
   * every other transition appends.
   */
  createVersion(
    tenantId: string,
    bookId: string,
    data: {
      reason: PriceChangeReason;
      note?: string;
      effectiveFrom: Date;
      copyFromVersionId?: string;
      createdById?: string;
    },
    buildAuditEntry: (version: PriceBookVersion) => AuditEntry,
  ): Promise<PriceBookVersion | VersionRejection> {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      const book = await tx.priceBook.findFirst({
        where: { id: bookId, tenantId: scopedTenantId },
        select: { id: true, status: true, currencyCode: true },
      });
      if (!book) {
        return 'book-not-found' as const;
      }
      if (book.status === PriceBookStatus.ARCHIVED) {
        return 'book-archived' as const;
      }
      let sourceEntries: Pick<
        PriceBookEntry,
        'productId' | 'unitPriceMinor' | 'currencyCode'
      >[] = [];
      if (data.copyFromVersionId) {
        const source = await tx.priceBookVersion.findFirst({
          where: {
            id: data.copyFromVersionId,
            tenantId: scopedTenantId,
            priceBookId: book.id,
          },
          select: {
            id: true,
            entries: {
              select: {
                productId: true,
                unitPriceMinor: true,
                currencyCode: true,
              },
            },
          },
        });
        if (!source) {
          return 'copy-source-not-found' as const;
        }
        sourceEntries = source.entries;
      }
      // versionNumber is monotonic per book and never reused. The aggregate
      // runs inside the transaction; the (priceBookId, versionNumber) unique
      // makes a lost race a failed insert rather than two version 4s.
      const highest = await tx.priceBookVersion.aggregate({
        where: { tenantId: scopedTenantId, priceBookId: book.id },
        _max: { versionNumber: true },
      });
      const version = await tx.priceBookVersion.create({
        data: {
          tenantId: scopedTenantId,
          priceBookId: book.id,
          versionNumber: (highest._max.versionNumber ?? 0) + 1,
          status: PriceBookVersionStatus.DRAFT,
          effectiveFrom: data.effectiveFrom,
          reason: data.reason,
          note: data.note,
          createdById: data.createdById,
        },
      });
      if (sourceEntries.length > 0) {
        await tx.priceBookEntry.createMany({
          data: sourceEntries.map((entry) => ({
            tenantId: scopedTenantId,
            versionId: version.id,
            productId: entry.productId,
            unitPriceMinor: entry.unitPriceMinor,
            currencyCode: book.currencyCode,
          })),
        });
      }
      await this.auditLog.record(buildAuditEntry(version), tx);
      return version;
    });
  }

  findVersion(
    tenantId: string,
    bookId: string,
    versionId: string,
  ): Promise<PriceBookVersionSummary | null> {
    return this.prisma.priceBookVersion.findFirst({
      where: this.scope(tenantId, { id: versionId, priceBookId: bookId }),
      select: VERSION_SUMMARY_SELECT,
    });
  }

  async findEntries(
    tenantId: string,
    bookId: string,
    versionId: string,
  ): Promise<PriceBookEntryWithProduct[] | 'version-not-found'> {
    const version = await this.findVersion(tenantId, bookId, versionId);
    if (!version) {
      return 'version-not-found';
    }
    return this.prisma.priceBookEntry.findMany({
      where: this.scope(tenantId, { versionId }),
      include: { product: { select: { id: true, sku: true, name: true } } },
      orderBy: [{ productId: 'asc' }],
    });
  }

  /**
   * The minimum an activation listener needs: where the book applies, and
   * which products the version prices. Kept here (rather than reusing
   * findEntries) so a listener never pulls whole entry rows — prices are not
   * a subscriber's business, only the fact that they changed.
   */
  async findActivationFacts(
    tenantId: string,
    bookId: string,
    versionId: string,
  ): Promise<{ locationId: string | null; productIds: string[] } | null> {
    const book = await this.prisma.priceBook.findFirst({
      where: this.scope(tenantId, { id: bookId }),
      select: { locationId: true },
    });
    if (!book) {
      return null;
    }
    const entries = await this.prisma.priceBookEntry.findMany({
      where: this.scope(tenantId, { versionId }),
      select: { productId: true },
      orderBy: { productId: 'asc' },
    });
    return {
      locationId: book.locationId,
      productIds: entries.map((entry) => entry.productId),
    };
  }

  /**
   * Replaces the entry set of a DRAFT version.
   *
   * The DRAFT check is the immutability invariant: once a version has been
   * activated its entries are frozen forever, because superseded versions
   * still answer historical price questions and an order that cited them must
   * remain explicable.
   */
  setEntries(
    tenantId: string,
    bookId: string,
    versionId: string,
    entries: readonly { productId: string; unitPriceMinor: number }[],
    buildAuditEntry: (version: PriceBookVersion, count: number) => AuditEntry,
  ): Promise<PriceBookVersion | VersionRejection> {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      const book = await tx.priceBook.findFirst({
        where: { id: bookId, tenantId: scopedTenantId },
        select: { id: true, status: true, currencyCode: true },
      });
      if (!book) {
        return 'book-not-found' as const;
      }
      if (book.status === PriceBookStatus.ARCHIVED) {
        return 'book-archived' as const;
      }
      const version = await tx.priceBookVersion.findFirst({
        where: {
          id: versionId,
          tenantId: scopedTenantId,
          priceBookId: book.id,
        },
      });
      if (!version) {
        return 'version-not-found' as const;
      }
      if (version.status !== PriceBookVersionStatus.DRAFT) {
        return 'version-not-draft' as const;
      }
      const productIds = [...new Set(entries.map((entry) => entry.productId))];
      const found = await tx.product.count({
        where: { tenantId: scopedTenantId, id: { in: productIds } },
      });
      if (found !== productIds.length) {
        return 'product-not-found' as const;
      }
      await tx.priceBookEntry.deleteMany({
        where: { tenantId: scopedTenantId, versionId: version.id },
      });
      await tx.priceBookEntry.createMany({
        data: entries.map((entry) => ({
          tenantId: scopedTenantId,
          versionId: version.id,
          productId: entry.productId,
          unitPriceMinor: entry.unitPriceMinor,
          currencyCode: book.currencyCode,
        })),
      });
      await this.auditLog.record(buildAuditEntry(version, entries.length), tx);
      return version;
    });
  }

  /**
   * Activates a DRAFT version and closes the window of the one it replaces.
   *
   * The two writes are one transaction, and the partial unique index
   * ("one ACTIVE version per book") means a lost race fails the insert rather
   * than leaving a book with two current versions.
   */
  activateVersion(
    tenantId: string,
    bookId: string,
    versionId: string,
    data: { effectiveFrom: Date; note?: string; activatedById?: string },
    builders: ActivationAuditBuilders,
  ): Promise<PriceBookVersion | VersionRejection> {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) =>
      this.activateWithin(
        tx,
        scopedTenantId,
        bookId,
        versionId,
        data,
        builders,
      ),
    );
  }

  /**
   * Rollback: copies a resolvable version's entries into a NEW version and
   * activates it. The source row is read-only throughout — reversibility
   * without rewriting history.
   */
  rollbackToVersion(
    tenantId: string,
    bookId: string,
    sourceVersionId: string,
    data: { note?: string; actorId?: string; at: Date },
    builders: RollbackAuditBuilders,
  ): Promise<PriceBookVersion | VersionRejection> {
    const scopedTenantId = this.requireTenantId(tenantId);
    return this.prisma.$transaction(async (tx) => {
      const book = await tx.priceBook.findFirst({
        where: { id: bookId, tenantId: scopedTenantId },
        select: { id: true, status: true, currencyCode: true },
      });
      if (!book) {
        return 'book-not-found' as const;
      }
      if (book.status === PriceBookStatus.ARCHIVED) {
        return 'book-archived' as const;
      }
      const source = await tx.priceBookVersion.findFirst({
        where: {
          id: sourceVersionId,
          tenantId: scopedTenantId,
          priceBookId: book.id,
        },
        select: {
          id: true,
          status: true,
          entries: { select: { productId: true, unitPriceMinor: true } },
        },
      });
      if (!source) {
        return 'version-not-found' as const;
      }
      // Rolling back to a draft would activate prices nobody ever approved,
      // and rolling back to an archived (withdrawn) version would resurrect
      // a decision that was explicitly abandoned.
      if (!RESOLVABLE.includes(source.status)) {
        return 'source-version-not-resolvable' as const;
      }
      if (source.entries.length === 0) {
        return 'version-empty' as const;
      }
      const highest = await tx.priceBookVersion.aggregate({
        where: { tenantId: scopedTenantId, priceBookId: book.id },
        _max: { versionNumber: true },
      });
      const copy = await tx.priceBookVersion.create({
        data: {
          tenantId: scopedTenantId,
          priceBookId: book.id,
          versionNumber: (highest._max.versionNumber ?? 0) + 1,
          status: PriceBookVersionStatus.DRAFT,
          effectiveFrom: data.at,
          reason: PriceChangeReason.ROLLBACK,
          note: data.note,
          rolledBackFromVersionId: source.id,
          createdById: data.actorId,
        },
      });
      await tx.priceBookEntry.createMany({
        data: source.entries.map((entry) => ({
          tenantId: scopedTenantId,
          versionId: copy.id,
          productId: entry.productId,
          unitPriceMinor: entry.unitPriceMinor,
          currencyCode: book.currencyCode,
        })),
      });
      await this.auditLog.record(builders.created(copy), tx);
      return this.activateWithin(
        tx,
        scopedTenantId,
        book.id,
        copy.id,
        { effectiveFrom: data.at, activatedById: data.actorId },
        builders,
      );
    });
  }

  private async activateWithin(
    tx: Prisma.TransactionClient,
    tenantId: string,
    bookId: string,
    versionId: string,
    data: { effectiveFrom: Date; note?: string; activatedById?: string },
    builders: ActivationAuditBuilders,
  ): Promise<PriceBookVersion | VersionRejection> {
    const book = await tx.priceBook.findFirst({
      where: { id: bookId, tenantId },
      select: { id: true, status: true },
    });
    if (!book) {
      return 'book-not-found' as const;
    }
    if (book.status === PriceBookStatus.ARCHIVED) {
      return 'book-archived' as const;
    }
    const target = await tx.priceBookVersion.findFirst({
      where: { id: versionId, tenantId, priceBookId: book.id },
    });
    if (!target) {
      return 'version-not-found' as const;
    }
    if (target.status !== PriceBookVersionStatus.DRAFT) {
      return 'version-not-activatable' as const;
    }
    const entryCount = await tx.priceBookEntry.count({
      where: { tenantId, versionId: target.id },
    });
    if (entryCount === 0) {
      // An empty version would silently unprice the whole book.
      return 'version-empty' as const;
    }
    const current = await tx.priceBookVersion.findFirst({
      where: {
        tenantId,
        priceBookId: book.id,
        status: PriceBookVersionStatus.ACTIVE,
      },
    });
    if (current) {
      // Windows are half-open and must move forward: the new version starts
      // exactly where the old one ends, so an effectiveFrom at or before the
      // current version's start would invert them.
      if (data.effectiveFrom.getTime() <= current.effectiveFrom.getTime()) {
        return 'effective-from-not-after-active' as const;
      }
      const supersededAfter = await tx.priceBookVersion.update({
        where: { id_tenantId: { id: current.id, tenantId } },
        data: {
          status: PriceBookVersionStatus.SUPERSEDED,
          effectiveTo: data.effectiveFrom,
          supersededByVersionId: target.id,
        },
      });
      if (builders.superseded) {
        await this.auditLog.record(
          builders.superseded(current, supersededAfter),
          tx,
        );
      }
    }
    const after = await tx.priceBookVersion.update({
      where: { id_tenantId: { id: target.id, tenantId } },
      data: {
        status: PriceBookVersionStatus.ACTIVE,
        effectiveFrom: data.effectiveFrom,
        effectiveTo: null,
        activatedAt: new Date(),
        activatedById: data.activatedById,
        note: data.note ?? target.note,
      },
    });
    await this.auditLog.record(builders.activated(target, after), tx);
    return after;
  }

  // ------------------------------------------------------------ resolution

  /**
   * Loads every price row that could apply to these products at `at`.
   * Filtering by window and specificity is left to pricing.logic.ts so the
   * decision stays pure and testable; this only narrows what the database has
   * to hand over.
   *
   * `client` lets checkout resolve prices INSIDE its own line transaction, so
   * the price snapshotted onto a basket line is read under the same locks that
   * created the line.
   */
  async findPriceCandidates(
    tenantId: string,
    productIds: readonly string[],
    at: Date,
    locationId?: string | null,
    client?: Prisma.TransactionClient,
  ): Promise<Map<string, PriceCandidate[]>> {
    const scopedTenantId = this.requireTenantId(tenantId);
    const byProduct = new Map<string, PriceCandidate[]>();
    if (productIds.length === 0) {
      return byProduct;
    }
    const db = client ?? this.prisma;
    const rows = await db.priceBookEntry.findMany({
      where: {
        tenantId: scopedTenantId,
        productId: { in: [...productIds] },
        version: {
          tenantId: scopedTenantId,
          status: { in: RESOLVABLE },
          effectiveFrom: { lte: at },
          OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
          priceBook: {
            tenantId: scopedTenantId,
            status: PriceBookStatus.ACTIVE,
            // A location-scoped book of ANOTHER location can never apply, so
            // it is excluded here rather than in the pure selector.
            OR: locationId
              ? [{ locationId: null }, { locationId }]
              : [{ locationId: null }],
          },
        },
      },
      select: {
        productId: true,
        unitPriceMinor: true,
        currencyCode: true,
        version: {
          select: {
            id: true,
            versionNumber: true,
            status: true,
            effectiveFrom: true,
            effectiveTo: true,
            priceBook: { select: { id: true, code: true, locationId: true } },
          },
        },
      },
    });
    for (const row of rows) {
      const candidate: PriceCandidate = {
        priceBookId: row.version.priceBook.id,
        priceBookCode: row.version.priceBook.code,
        priceBookLocationId: row.version.priceBook.locationId,
        priceBookVersionId: row.version.id,
        versionNumber: row.version.versionNumber,
        status: row.version.status as 'ACTIVE' | 'SUPERSEDED',
        effectiveFrom: row.version.effectiveFrom,
        effectiveTo: row.version.effectiveTo,
        unitPriceMinor: row.unitPriceMinor,
        currencyCode: row.currencyCode,
      };
      const bucket = byProduct.get(row.productId);
      if (bucket) {
        bucket.push(candidate);
      } else {
        byProduct.set(row.productId, [candidate]);
      }
    }
    return byProduct;
  }
}
