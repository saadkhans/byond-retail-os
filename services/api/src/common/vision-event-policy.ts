import { VisionEventType } from '@prisma/client';

/**
 * Event types whose APPROVAL mutates the linked session's basket. Shared by
 * the vision review flow (which applies them) and the checkout line APIs
 * (which must REJECT them as manual lineage while pending — the review
 * endpoint is the ONLY path that may apply a basket-affecting event, or the
 * same event could be counted twice). Lives in common/ so neither repository
 * has to import the other.
 */
export const BASKET_AFFECTING_EVENT_TYPES: readonly VisionEventType[] = [
  VisionEventType.PRODUCT_PICKUP,
  VisionEventType.CART_INSERTION,
  VisionEventType.PRODUCT_RETURN,
];
