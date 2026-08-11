import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  InventoryMovement,
  InventoryMovementType,
} from '@prisma/client';
import {
  AuditActor,
  SYSTEM_ACTOR_EMAIL,
} from '../common/audit/audit-log.service';
import { containsSensitiveValue } from '../common/sensitive-keys';
import { AdjustStockDto } from './dto/adjust-stock.dto';
import {
  EXTERNAL_MOVEMENT_TYPES,
  RecordMovementDto,
} from './dto/record-movement.dto';
import { QueryLevelsDto, QueryMovementsDto } from './dto/query-inventory.dto';
import {
  AdjustmentResult,
  InventoryLevelWithRefs,
  InventoryRepository,
} from './inventory.repository';

export interface StockLevelView extends InventoryLevelWithRefs {
  /** quantity <= product.lowStockThreshold (false when no threshold set). */
  isLowStock: boolean;
}

/**
 * Movement reasons and references are persisted verbatim into the
 * APPEND-ONLY InventoryMovement ledger (rows are never updated or deleted),
 * and the reason also flows into AuditLog.reason, which audit redaction
 * does not cover. Reject credential-/payment-bearing content (a pasted PAN,
 * token, or credential URL) with a controlled 400 BEFORE any repository
 * write — AGENTS.md payments invariant; same containsSensitiveValue gate as
 * the checkout idempotency key and the order cancellation reason.
 */
function assertSafeLedgerText(
  field: 'reason' | 'reference',
  value: string,
): void {
  if (containsSensitiveValue(value)) {
    throw new BadRequestException(
      `${field} must not contain credential- or payment-bearing values`,
    );
  }
}

@Injectable()
export class InventoryService {
  constructor(private readonly inventoryRepository: InventoryRepository) {}

  async adjustStock(
    tenantId: string,
    dto: AdjustStockDto,
    actor: AuditActor,
  ): Promise<AdjustmentResult> {
    const reason = dto.reason.trim();
    if (!reason) {
      throw new BadRequestException('An adjustment reason is required');
    }
    assertSafeLedgerText('reason', reason);
    // Redundant with the DTO, deliberately: the zero/integer invariant
    // protects ledger integrity, so the service does not rely on transport
    // validation alone.
    if (!Number.isInteger(dto.quantityDelta) || dto.quantityDelta === 0) {
      throw new BadRequestException(
        'quantityDelta must be a non-zero integer',
      );
    }

    const result = await this.inventoryRepository.adjust(
      tenantId,
      {
        locationId: dto.locationId,
        productId: dto.productId,
        quantityDelta: dto.quantityDelta,
        reason,
        createdById: actor.id,
      },
      (movement, level) => ({
        tenantId,
        actorId: actor.id,
        actorEmail: actor.email || SYSTEM_ACTOR_EMAIL,
        action: AuditAction.STOCK_ADJUSTMENT,
        entityType: 'InventoryMovement',
        entityId: movement.id,
        before: { quantity: level.quantity - movement.quantityDelta },
        after: {
          quantity: level.quantity,
          quantityDelta: movement.quantityDelta,
          locationId: movement.locationId,
          productId: movement.productId,
        },
        reason,
      }),
    );

    switch (result) {
      case 'location-not-found':
        throw new NotFoundException(`Location "${dto.locationId}" not found`);
      case 'product-not-found':
        throw new NotFoundException(`Product "${dto.productId}" not found`);
      case 'product-archived':
        throw new ConflictException(
          'Stock of an ARCHIVED product cannot be adjusted',
        );
      // Unreachable through manual adjustments (ADJUSTMENT movements never
      // set a UOM snapshot and are allowed on non-ACTIVE products); mapped
      // defensively so any future caller still gets a controlled 409.
      case 'product-not-saleable':
        throw new ConflictException(
          'Stock movement rejected: the product is not ACTIVE',
        );
      case 'unit-of-measure-changed':
        throw new ConflictException(
          'Stock movement rejected: the product unit of measure changed',
        );
      case 'insufficient-stock':
        throw new ConflictException(
          'Adjustment rejected: it would take on-hand stock below zero',
        );
      case 'quantity-overflow':
        throw new ConflictException(
          'Adjustment rejected: it would take on-hand stock above the ' +
            'maximum supported quantity',
        );
      // Unreachable through manual adjustments (only reference-keyed
      // external movements replay); mapped defensively to a controlled 409.
      case 'reference-mismatch':
        throw new ConflictException(
          'Adjustment rejected: idempotency reference reused for a ' +
            'different movement',
        );
      default:
        return result;
    }
  }

  /**
   * Operator-recorded external movement (RECEIPT / CORRECTION_IN /
   * CORRECTION_OUT). NEVER an overwrite: the ledger appends and the level
   * is projected atomically, exactly like every other movement. Idempotent
   * by `reference` — a browser retry replays the recorded movement.
   */
  async recordMovement(
    tenantId: string,
    dto: RecordMovementDto,
    actor: AuditActor,
  ): Promise<AdjustmentResult & { replayed: boolean }> {
    const reason = dto.reason.trim();
    if (!reason) {
      throw new BadRequestException('A movement reason is required');
    }
    assertSafeLedgerText('reason', reason);
    // The reference charset ([A-Za-z0-9._-]) still admits a dash-grouped
    // PAN, so it gets the same screen as the reason.
    assertSafeLedgerText('reference', dto.reference);
    // Redundant with the DTO on purpose — ledger integrity never rests on
    // transport validation alone.
    if (!Number.isInteger(dto.quantity) || dto.quantity < 1) {
      throw new BadRequestException('quantity must be a whole number >= 1');
    }
    if (!EXTERNAL_MOVEMENT_TYPES.includes(dto.movementType)) {
      throw new BadRequestException('Unsupported movement type');
    }
    const quantityDelta =
      dto.movementType === 'CORRECTION_OUT' ? -dto.quantity : dto.quantity;
    const result = await this.inventoryRepository.recordExternalMovement(
      tenantId,
      {
        locationId: dto.locationId,
        productId: dto.productId,
        movementType: dto.movementType as InventoryMovementType,
        quantityDelta,
        reason,
        reference: dto.reference,
        createdById: actor.id,
      },
      (movement, level) => ({
        tenantId,
        actorId: actor.id,
        actorEmail: actor.email || SYSTEM_ACTOR_EMAIL,
        action: AuditAction.STOCK_ADJUSTMENT,
        entityType: 'InventoryMovement',
        entityId: movement.id,
        before: { quantity: level.quantity - movement.quantityDelta },
        after: {
          quantity: level.quantity,
          quantityDelta: movement.quantityDelta,
          movementType: movement.movementType,
          locationId: movement.locationId,
          productId: movement.productId,
          reference: dto.reference,
        },
        reason,
      }),
    );
    if (typeof result === 'string') {
      switch (result) {
        case 'location-not-found':
          throw new NotFoundException(`Location "${dto.locationId}" not found`);
        case 'product-not-found':
          throw new NotFoundException(`Product "${dto.productId}" not found`);
        case 'product-archived':
          throw new ConflictException(
            'Stock of an ARCHIVED product cannot be moved',
          );
        case 'insufficient-stock':
          throw new ConflictException(
            'Movement rejected: it would take on-hand stock below zero',
          );
        case 'quantity-overflow':
          throw new ConflictException(
            'Movement rejected: it would exceed the maximum quantity',
          );
        case 'reference-mismatch':
          throw new ConflictException(
            'Movement rejected: this reference was already used for a ' +
              'different movement — reuse a reference only to retry the ' +
              'identical request',
          );
        default:
          throw new ConflictException(`Movement rejected: ${result}`);
      }
    }
    return result;
  }

  async getLevels(
    tenantId: string,
    query: QueryLevelsDto,
  ): Promise<StockLevelView[]> {
    const levels = await this.inventoryRepository.findLevels(tenantId, {
      locationId: query.locationId,
      productId: query.productId,
    });
    const views = levels.map((level) => ({
      ...level,
      isLowStock:
        level.product.lowStockThreshold !== null &&
        level.quantity <= level.product.lowStockThreshold,
    }));
    if (query.lowStockOnly === 'true') {
      return views.filter((view) => view.isLowStock);
    }
    return views;
  }

  getMovements(
    tenantId: string,
    query: QueryMovementsDto,
  ): Promise<{ items: InventoryMovement[]; total: number }> {
    return this.inventoryRepository.findMovements(tenantId, {
      locationId: query.locationId,
      productId: query.productId,
      skip: query.skip,
      take: query.take,
    });
  }
}
