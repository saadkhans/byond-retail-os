import { Injectable } from '@nestjs/common';
import {
  CustomerJourneyStatus,
  OrderPaymentStatus,
  StoreEntryTokenStatus,
  StoreFlowSettlementStatus,
  TenantStatus,
  UserStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Phase 35 — every database access the shopper surface makes.
 *
 * TWO RULES hold here and are pinned by boundary.spec.ts:
 *
 *   1. EVERY method is a READ. This module changes nothing on its own; the
 *      only writes a shopper can cause are the ones Phase 26's
 *      StoreFlowService already performs, through its own audited,
 *      idempotent, inventory-validated path.
 *
 *   2. Every read except the credential lookup carries `tenantId` in its
 *      WHERE clause, and that tenant id comes from the CREDENTIAL ROW — never
 *      from a request body, a header, a query string or a URL. A shopper has
 *      no way to name a tenant, so a shopper has no way to reach one.
 *
 * The credential lookup is the single exception, and it must be: the caller
 * is anonymous and the tenant is precisely what is being established. It is
 * keyed by an unguessable 32-byte digest and resolves to at most one row —
 * see findCredentialByHash.
 */

export interface ShopperCredentialLookup {
  id: string;
  tenantId: string;
  status: StoreEntryTokenStatus;
  redeemedAt: Date | null;
  redeemedJourneyId: string | null;
  issuedById: string | null;
}

export interface ShopperJourneyRow {
  id: string;
  locationId: string;
  status: CustomerJourneyStatus;
  checkoutSessionId: string | null;
  orderId: string | null;
  settlementStatus: StoreFlowSettlementStatus;
}

export interface ShopperOrderRow {
  orderNumber: string;
  totalMinor: number | null;
  currencyCode: string | null;
  paymentStatus: OrderPaymentStatus | null;
}

@Injectable()
export class ShopperRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolve an entry credential digest to its row, across all tenants.
   *
   * `StoreEntryToken` is unique on `[tenantId, tokenHash]`, NOT on the hash
   * alone, so this deliberately reads two rows and returns nothing unless
   * exactly one came back. A digest collision across tenants is not
   * realistically reachable with 32 bytes of entropy, but "not reachable" is
   * not the same as "handled": an ambiguous digest must never be resolved by
   * picking whichever row sorted first, because that picks a TENANT.
   */
  async findCredentialByHash(
    tokenHash: string,
  ): Promise<ShopperCredentialLookup | null> {
    const rows = await this.prisma.storeEntryToken.findMany({
      where: { tokenHash },
      select: {
        id: true,
        tenantId: true,
        status: true,
        redeemedAt: true,
        redeemedJourneyId: true,
        issuedById: true,
      },
      take: 2,
    });
    return rows.length === 1 ? rows[0] : null;
  }

  /** Is the tenant behind a credential still allowed to trade at all? */
  async tenantIsActive(tenantId: string): Promise<boolean> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { status: true },
    });
    return tenant?.status === TenantStatus.ACTIVE;
  }

  /**
   * The operator who issued the credential, if they are still an active user
   * of that tenant. Actions a shopper takes are attributed to them.
   */
  async findActiveIssuer(
    tenantId: string,
    userId: string,
  ): Promise<{ id: string; email: string } | null> {
    return this.prisma.user.findFirst({
      where: { id: userId, tenantId, status: UserStatus.ACTIVE },
      select: { id: true, email: true },
    });
  }

  /** The journey a credential opened — read within its own tenant only. */
  async findJourney(
    tenantId: string,
    journeyId: string,
  ): Promise<ShopperJourneyRow | null> {
    return this.prisma.customerJourney.findFirst({
      where: { tenantId, id: journeyId },
      select: {
        id: true,
        locationId: true,
        status: true,
        checkoutSessionId: true,
        orderId: true,
        settlementStatus: true,
      },
    });
  }

  /**
   * The active lines of the basket bound to this journey.
   *
   * `productId` is not selected: the shopper view has no use for a catalog
   * primary key, and a field that is never read cannot be leaked.
   */
  async basketLines(tenantId: string, sessionId: string) {
    return this.prisma.checkoutSessionLine.findMany({
      where: { tenantId, sessionId, status: 'ACTIVE' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        sku: true,
        productName: true,
        quantity: true,
        unitPriceMinor: true,
        lineTotalMinor: true,
        currencyCode: true,
      },
    });
  }

  /** The order a settled journey became. Totals only — no lines, no actors. */
  async findOrder(
    tenantId: string,
    orderId: string,
  ): Promise<ShopperOrderRow | null> {
    return this.prisma.order.findFirst({
      where: { tenantId, id: orderId },
      select: {
        orderNumber: true,
        totalMinor: true,
        currencyCode: true,
        paymentStatus: true,
      },
    });
  }
}
