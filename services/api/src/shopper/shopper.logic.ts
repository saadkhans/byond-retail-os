import {
  CustomerJourneyStatus,
  OrderPaymentStatus,
  StoreEntryTokenStatus,
  StoreFlowAutonomyLevel,
  StoreFlowSettlementStatus,
} from '@prisma/client';
import { SETTLEMENT_BLOCK_REASON } from '../store-flow/store-flow.constants';
import {
  SHOPPER_CREDENTIAL_SCHEME,
  SHOPPER_SESSION_MAX_SECONDS,
} from './shopper.constants';

/**
 * Phase 35 — the pure decisions behind the shopper surface.
 *
 * Total functions of their arguments: no database, no clock beyond what is
 * passed in, no I/O. Credential parsing, session validity and the shape of
 * what a shopper is allowed to see all live here so they can be read in one
 * sitting and tested exhaustively.
 */

/**
 * The secret out of an `Authorization: Shopper <secret>` header, or null.
 *
 * The shape check is the SAME base64url alphabet and bounds Phase 26's
 * redeem DTO enforces, so a malformed credential is rejected before it ever
 * becomes a database round trip — and the route below answers identically
 * whether the credential was malformed or simply wrong.
 */
export function parseShopperCredential(
  header: string | undefined | null,
): string | null {
  if (typeof header !== 'string') {
    return null;
  }
  const separator = header.indexOf(' ');
  if (separator <= 0) {
    return null;
  }
  const scheme = header.slice(0, separator);
  if (scheme.toLowerCase() !== SHOPPER_CREDENTIAL_SCHEME.toLowerCase()) {
    return null;
  }
  const secret = header.slice(separator + 1).trim();
  if (!/^[A-Za-z0-9_-]{16,200}$/.test(secret)) {
    return null;
  }
  return secret;
}

/** The credential row as this module reads it. Never the digest's owner. */
export interface ShopperCredentialRow {
  id: string;
  tenantId: string;
  status: StoreEntryTokenStatus;
  redeemedAt: Date | null;
  redeemedJourneyId: string | null;
  issuedById: string | null;
}

export type ShopperSessionDenial =
  | 'NOT_REDEEMED'
  | 'NO_JOURNEY'
  | 'NO_ISSUER'
  | 'SESSION_EXPIRED';

/**
 * Is a redeemed credential still a usable session credential?
 *
 * The reason is for THIS SERVER's tests and logs only — every caller of this
 * function answers with one generic message, because a shopper who cannot
 * get in learns nothing from being told which of four things went wrong,
 * while an attacker learns a great deal.
 */
export function shopperSessionUsable(
  row: ShopperCredentialRow,
  now: Date,
): { usable: boolean; reason?: ShopperSessionDenial } {
  if (row.status !== StoreEntryTokenStatus.REDEEMED) {
    return { usable: false, reason: 'NOT_REDEEMED' };
  }
  if (!row.redeemedJourneyId) {
    return { usable: false, reason: 'NO_JOURNEY' };
  }
  if (!row.issuedById) {
    // Every action this surface takes is attributed to the operator who
    // issued the credential (see shopper.service.ts). A credential with no
    // issuer has nobody accountable for it, so it opens no session.
    return { usable: false, reason: 'NO_ISSUER' };
  }
  if (!row.redeemedAt) {
    return { usable: false, reason: 'NOT_REDEEMED' };
  }
  const ageSeconds = (now.getTime() - row.redeemedAt.getTime()) / 1000;
  if (ageSeconds < 0 || ageSeconds > SHOPPER_SESSION_MAX_SECONDS) {
    return { usable: false, reason: 'SESSION_EXPIRED' };
  }
  return { usable: true };
}

/**
 * One basket line, as the shopper sees it.
 *
 * `productId` is deliberately absent: the shopper reads a SKU and a name,
 * and internal catalog identifiers are nobody's business outside the tenant.
 */
export interface ShopperBasketLine {
  id: string;
  sku: string;
  productName: string;
  quantity: number;
  unitPriceMinor: number | null;
  lineTotalMinor: number | null;
  currencyCode: string | null;
}

export interface BasketLineInput {
  id: string;
  sku: string;
  productName: string;
  quantity: number;
  unitPriceMinor: number | null;
  lineTotalMinor: number | null;
  currencyCode: string | null;
}

export interface ShopperBasket {
  lines: ShopperBasketLine[];
  totalMinor: number;
  currencyCode: string | null;
  /** True when a line could not be valued, so the total is not the whole story. */
  hasUnpricedLine: boolean;
}

/**
 * Add the basket up without ever guessing.
 *
 * A line with no price is NOT counted as zero — it is reported, so the app
 * can say "we cannot total this yet" instead of showing a number that is
 * quietly too small. Mixed currencies are impossible in one session by
 * construction; if one ever appeared the currency is dropped rather than
 * asserted.
 */
export function summariseBasket(
  lines: readonly BasketLineInput[],
): ShopperBasket {
  const currencies = new Set(
    lines
      .map((line) => line.currencyCode)
      .filter((code): code is string => typeof code === 'string'),
  );
  return {
    lines: lines.map((line) => ({
      id: line.id,
      sku: line.sku,
      productName: line.productName,
      quantity: line.quantity,
      unitPriceMinor: line.unitPriceMinor,
      lineTotalMinor: line.lineTotalMinor,
      currencyCode: line.currencyCode,
    })),
    totalMinor: lines.reduce((sum, line) => sum + (line.lineTotalMinor ?? 0), 0),
    currencyCode: currencies.size === 1 ? [...currencies][0] : null,
    hasUnpricedLine: lines.some(
      (line) => line.lineTotalMinor === null || line.lineTotalMinor === undefined,
    ),
  };
}

/** What the store is actually doing with what the shopper picks up. */
export interface ShopperDetectionView {
  autonomyLevel: StoreFlowAutonomyLevel;
  /**
   * False under SHADOW. The store is watching and recording, and the basket
   * below will legitimately stay empty. Saying so is the whole point — a
   * shopper staring at an empty list must not be left to assume the cameras
   * failed, and must certainly not be left to assume they are being billed.
   */
  active: boolean;
  /** Whether walking out settles the basket, or a colleague finishes it. */
  settlesOnExit: boolean;
}

export function detectionView(policy: {
  autonomyLevel: StoreFlowAutonomyLevel;
  settleOnExit: boolean;
}): ShopperDetectionView {
  return {
    autonomyLevel: policy.autonomyLevel,
    active: policy.autonomyLevel !== StoreFlowAutonomyLevel.SHADOW,
    settlesOnExit: policy.settleOnExit,
  };
}

export interface ShopperSettlementView {
  status: StoreFlowSettlementStatus;
  /** Phase 26's controlled vocabulary, never prose. */
  blockedBy: string | null;
  orderNumber: string | null;
  paidMinor: number | null;
  currencyCode: string | null;
  paymentStatus: OrderPaymentStatus | null;
}

/**
 * The settlement as it stands on a plain read.
 *
 * An exit RETURNS its own blocking reason; a later refresh has only the
 * journey row, so a journey parked at BLOCKED_ON_REVIEW re-derives the one
 * reason that state can mean. Nothing else is inferred.
 */
export function settlementViewFromJourney(
  journey: { settlementStatus: StoreFlowSettlementStatus },
  order: {
    orderNumber: string;
    totalMinor: number | null;
    currencyCode: string | null;
    paymentStatus: OrderPaymentStatus | null;
  } | null,
): ShopperSettlementView {
  return {
    status: journey.settlementStatus,
    blockedBy:
      journey.settlementStatus === StoreFlowSettlementStatus.BLOCKED_ON_REVIEW
        ? SETTLEMENT_BLOCK_REASON.AWAITING_EVENT_REVIEW
        : null,
    orderNumber: order?.orderNumber ?? null,
    paidMinor: order?.totalMinor ?? null,
    currencyCode: order?.currencyCode ?? null,
    paymentStatus: order?.paymentStatus ?? null,
  };
}

/** Everything a shopper is allowed to see about their own visit. */
export interface ShopperView {
  journeyId: string;
  journeyStatus: CustomerJourneyStatus;
  detection: ShopperDetectionView;
  basket: ShopperBasket;
  settlement: ShopperSettlementView;
}
