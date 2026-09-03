import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PlanogramRackStatus } from '@prisma/client';
import { planogramRackAdvisoryLockKey } from '../common/locks';
import { PrismaService } from '../prisma/prisma.service';
import { containsSensitiveFreeText } from '../video-ingest/media-safety';
import {
  MAX_PLANOGRAM_COLUMNS,
  MAX_PLANOGRAM_ROWS,
  NarrowedCandidates,
  cellCodeFor,
  narrowFromAssignments,
} from './planogram.logic';

/**
 * Phase 19 — planogram (rack/shelf/cell placement) management and SOFT
 * SKU-candidate narrowing.
 *
 * WRITE DISCIPLINE (pinned by shadow-mode.spec.ts): this service writes
 * ONLY its own planogram tables. A planogram is scoring EVIDENCE for the
 * vision pipeline — it never mutates checkout, order, payment,
 * settlement, or inventory state, and it never rejects a SKU: it
 * re-orders candidate priority and flags disagreement for human review.
 *
 * VERSIONING: publishing a layout for an existing rackCode deactivates
 * the current ACTIVE version and creates version+1 under an advisory
 * lock. Old evidence keeps the version it was scored against, so a
 * planogram edit can never silently rewrite reviewed candidate labels.
 */

const RACK_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{0,31}$/;

export interface PlanogramCellInput {
  rowIndex: number;
  columnIndex: number;
  productId: string;
  isPrimary?: boolean;
  facingCount?: number;
}

export interface PlanogramRackView {
  rackId: string;
  locationId: string;
  rackCode: string;
  name: string | null;
  rows: number;
  columns: number;
  version: number;
  status: string;
  activeFrom: Date;
  activeTo: Date | null;
  cells: {
    cellCode: string;
    rowIndex: number;
    columnIndex: number;
    productId: string;
    sku: string;
    isPrimary: boolean;
    facingCount: number;
  }[];
}

@Injectable()
export class PlanogramService {
  constructor(private readonly prisma: PrismaService) {}

  private toView(
    rack: {
      id: string;
      locationId: string;
      rackCode: string;
      name: string | null;
      rows: number;
      columns: number;
      version: number;
      status: string;
      activeFrom: Date;
      activeTo: Date | null;
    },
    cells: {
      cellCode: string;
      rowIndex: number;
      columnIndex: number;
      productId: string;
      skuCodeSnapshot: string;
      isPrimary: boolean;
      facingCount: number;
    }[],
  ): PlanogramRackView {
    return {
      rackId: rack.id,
      locationId: rack.locationId,
      rackCode: rack.rackCode,
      name: rack.name,
      rows: rack.rows,
      columns: rack.columns,
      version: rack.version,
      status: rack.status,
      activeFrom: rack.activeFrom,
      activeTo: rack.activeTo,
      cells: cells.map((cell) => ({
        cellCode: cell.cellCode,
        rowIndex: cell.rowIndex,
        columnIndex: cell.columnIndex,
        productId: cell.productId,
        sku: cell.skuCodeSnapshot,
        isPrimary: cell.isPrimary,
        facingCount: cell.facingCount,
      })),
    };
  }

  /**
   * Publish a rack layout (create, or version-bump an existing rackCode).
   * Cell codes are DERIVED server-side from row/column indices — callers
   * can never write a code that disagrees with the grid position.
   */
  async publishRack(
    tenantId: string,
    input: {
      locationId: string;
      rackCode: string;
      name?: string | null;
      rows: number;
      columns: number;
      cells: PlanogramCellInput[];
    },
    actorId?: string,
  ): Promise<PlanogramRackView> {
    const rackCode = input.rackCode?.toUpperCase?.() ?? '';
    if (!RACK_CODE_PATTERN.test(rackCode)) {
      throw new BadRequestException(
        'rackCode must be 1-32 chars of A-Z, 0-9, "-", "_"',
      );
    }
    if (
      !Number.isInteger(input.rows) ||
      input.rows < 1 ||
      input.rows > MAX_PLANOGRAM_ROWS ||
      !Number.isInteger(input.columns) ||
      input.columns < 1 ||
      input.columns > MAX_PLANOGRAM_COLUMNS
    ) {
      throw new BadRequestException(
        `rows must be 1..${MAX_PLANOGRAM_ROWS} and columns 1..${MAX_PLANOGRAM_COLUMNS}`,
      );
    }
    const name = input.name?.trim() || null;
    if (name && (name.length > 120 || containsSensitiveFreeText(name))) {
      throw new BadRequestException(
        'name must be at most 120 characters and carry no sensitive content',
      );
    }
    const location = await this.prisma.location.findFirst({
      where: { tenantId, id: input.locationId },
      select: { id: true },
    });
    if (!location) {
      throw new NotFoundException('Store not found in this tenant');
    }
    if (!Array.isArray(input.cells) || input.cells.length === 0) {
      throw new BadRequestException('at least one cell assignment is required');
    }
    if (input.cells.length > 500) {
      throw new BadRequestException('at most 500 cell assignments per rack');
    }
    for (const cell of input.cells) {
      if (
        !Number.isInteger(cell.rowIndex) ||
        cell.rowIndex < 0 ||
        cell.rowIndex >= input.rows ||
        !Number.isInteger(cell.columnIndex) ||
        cell.columnIndex < 0 ||
        cell.columnIndex >= input.columns
      ) {
        throw new BadRequestException(
          'every cell assignment must sit inside the rack grid',
        );
      }
      const facing = cell.facingCount ?? 1;
      if (!Number.isInteger(facing) || facing < 1 || facing > 99) {
        throw new BadRequestException('facingCount must be 1..99');
      }
    }
    // TENANT ISOLATION at the data boundary: every assigned product must
    // resolve inside THIS tenant — a foreign product id can never enter
    // a planogram (and its SKU snapshot comes from the tenant's catalog).
    const productIds = [...new Set(input.cells.map((cell) => cell.productId))];
    const products = await this.prisma.product.findMany({
      where: { tenantId, id: { in: productIds } },
      select: { id: true, sku: true },
    });
    const skuById = new Map(products.map((row) => [row.id, row.sku]));
    if (skuById.size !== productIds.length) {
      throw new NotFoundException('Product not found in this tenant');
    }
    // No duplicate product within one cell.
    const seen = new Set<string>();
    for (const cell of input.cells) {
      const key = `${cell.rowIndex}:${cell.columnIndex}:${cell.productId}`;
      if (seen.has(key)) {
        throw new BadRequestException(
          'the same product appears twice in one cell',
        );
      }
      seen.add(key);
    }

    const rack = await this.prisma.$transaction(async (tx) => {
      // ::text cast is load-bearing (see common/locks.ts).
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${planogramRackAdvisoryLockKey(
        tenantId,
        input.locationId,
        rackCode,
      )}))::text`;
      const current = await tx.planogramRack.findFirst({
        where: {
          tenantId,
          locationId: input.locationId,
          rackCode,
          status: PlanogramRackStatus.ACTIVE,
        },
        orderBy: [{ version: 'desc' }],
        select: { id: true, version: true },
      });
      if (current) {
        // The predecessor stays queryable for evidence traceability —
        // it is deactivated, never deleted or rewritten.
        await tx.planogramRack.updateMany({
          where: { tenantId, id: current.id },
          data: { status: PlanogramRackStatus.INACTIVE, activeTo: new Date() },
        });
      }
      const created = await tx.planogramRack.create({
        data: {
          tenantId,
          locationId: input.locationId,
          rackCode,
          name,
          rows: input.rows,
          columns: input.columns,
          version: (current?.version ?? 0) + 1,
          createdById: actorId ?? null,
        },
      });
      await tx.planogramCellAssignment.createMany({
        data: input.cells.map((cell) => ({
          tenantId,
          rackId: created.id,
          cellCode: cellCodeFor(cell.rowIndex, cell.columnIndex),
          rowIndex: cell.rowIndex,
          columnIndex: cell.columnIndex,
          productId: cell.productId,
          skuCodeSnapshot: skuById.get(cell.productId) as string,
          isPrimary: cell.isPrimary ?? true,
          facingCount: cell.facingCount ?? 1,
        })),
      });
      return created;
    });
    return this.rackDetail(tenantId, rack.id);
  }

  async rackDetail(
    tenantId: string,
    rackId: string,
  ): Promise<PlanogramRackView> {
    const rack = await this.prisma.planogramRack.findFirst({
      where: { tenantId, id: rackId },
    });
    if (!rack) {
      throw new NotFoundException('Planogram rack not found');
    }
    const cells = await this.prisma.planogramCellAssignment.findMany({
      where: { tenantId, rackId },
      orderBy: [{ rowIndex: 'asc' }, { columnIndex: 'asc' }, { id: 'asc' }],
    });
    return this.toView(rack, cells);
  }

  async listRacks(
    tenantId: string,
    locationId?: string,
  ): Promise<PlanogramRackView[]> {
    const racks = await this.prisma.planogramRack.findMany({
      where: {
        tenantId,
        ...(locationId ? { locationId } : {}),
        status: PlanogramRackStatus.ACTIVE,
      },
      orderBy: [{ rackCode: 'asc' }, { version: 'desc' }],
      take: 100,
    });
    const cells = racks.length
      ? await this.prisma.planogramCellAssignment.findMany({
          where: { tenantId, rackId: { in: racks.map((rack) => rack.id) } },
          orderBy: [{ rowIndex: 'asc' }, { columnIndex: 'asc' }, { id: 'asc' }],
        })
      : [];
    return racks.map((rack) =>
      this.toView(
        rack,
        cells.filter((cell) => cell.rackId === rack.id),
      ),
    );
  }

  async deactivateRack(tenantId: string, rackId: string): Promise<void> {
    const updated = await this.prisma.planogramRack.updateMany({
      where: { tenantId, id: rackId, status: PlanogramRackStatus.ACTIVE },
      data: { status: PlanogramRackStatus.INACTIVE, activeTo: new Date() },
    });
    if (updated.count === 0) {
      throw new NotFoundException('Active planogram rack not found');
    }
  }

  /**
   * Tiered SKU narrowing for a normalized rack position. Returns null
   * when no ACTIVE planogram exists for the rack (the caller reports
   * PLANOGRAM_NOT_CONFIGURED and searches the full catalog) — narrowing
   * is a soft prior, never a gatekeeper.
   */
  async narrowCandidates(
    tenantId: string,
    input: {
      locationId: string;
      rackCode: string;
      normalizedRackX?: number | null;
      normalizedRackY?: number | null;
    },
  ): Promise<
    | (NarrowedCandidates & {
        rackId: string;
        rackCode: string;
        version: number;
      })
    | null
  > {
    const rack = await this.prisma.planogramRack.findFirst({
      where: {
        tenantId,
        locationId: input.locationId,
        rackCode: input.rackCode?.toUpperCase?.() ?? '',
        status: PlanogramRackStatus.ACTIVE,
      },
      orderBy: [{ version: 'desc' }],
    });
    if (!rack) {
      return null;
    }
    const assignments = await this.prisma.planogramCellAssignment.findMany({
      where: { tenantId, rackId: rack.id },
    });
    const point =
      typeof input.normalizedRackX === 'number' &&
      typeof input.normalizedRackY === 'number' &&
      Number.isFinite(input.normalizedRackX) &&
      Number.isFinite(input.normalizedRackY)
        ? {
            normalizedX: input.normalizedRackX,
            normalizedY: input.normalizedRackY,
          }
        : null;
    return {
      rackId: rack.id,
      rackCode: rack.rackCode,
      version: rack.version,
      ...narrowFromAssignments(rack, assignments, point),
    };
  }
}
