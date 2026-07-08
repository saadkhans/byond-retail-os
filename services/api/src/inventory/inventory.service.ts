import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, InventoryMovement } from '@prisma/client';
import {
  AuditActor,
  SYSTEM_ACTOR_EMAIL,
} from '../common/audit/audit-log.service';
import { AdjustStockDto } from './dto/adjust-stock.dto';
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
      case 'insufficient-stock':
        throw new ConflictException(
          'Adjustment rejected: it would take on-hand stock below zero',
        );
      case 'quantity-overflow':
        throw new ConflictException(
          'Adjustment rejected: it would take on-hand stock above the ' +
            'maximum supported quantity',
        );
      default:
        return result;
    }
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
