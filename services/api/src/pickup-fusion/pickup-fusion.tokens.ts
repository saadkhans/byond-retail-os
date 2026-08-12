import { PrismaService } from '../prisma/prisma.service';
import { VisualRetriever } from './ports';

/**
 * Injection tokens for every fusion-stage PORT — the same pattern as
 * PICKUP_VLM_VERIFIER (vlm-provider.ts). The orchestration service
 * injects these tokens with port types only; the module binds each token
 * to its concrete adapter. Swapping an adapter (YOLO for the classical
 * detector, CLIP for the HOG retriever) rebinds a token here-adjacent in
 * the module — the service never changes and never imports a vendor.
 */

export const PICKUP_MEDIA_DECODER = 'PICKUP_MEDIA_DECODER';
export const PICKUP_EVENT_DETECTOR = 'PICKUP_EVENT_DETECTOR';
export const PICKUP_OBJECT_DETECTOR = 'PICKUP_OBJECT_DETECTOR';
export const PICKUP_BARCODE_READER = 'PICKUP_BARCODE_READER';
export const PICKUP_OCR_READER = 'PICKUP_OCR_READER';
export const PICKUP_VISUAL_RETRIEVER = 'PICKUP_VISUAL_RETRIEVER';
export const PICKUP_CLASSICAL_MATCHER = 'PICKUP_CLASSICAL_MATCHER';
export const PICKUP_CONTEXT_PROVIDER = 'PICKUP_CONTEXT_PROVIDER';
export const PICKUP_CANDIDATE_FUSION = 'PICKUP_CANDIDATE_FUSION';
export const PICKUP_INVENTORY_VALIDATOR = 'PICKUP_INVENTORY_VALIDATOR';

/**
 * Factory for a VisualRetriever bound to a TRANSACTION-scoped Prisma
 * client. The atomic index rebuild must reconstruct through the SAME
 * transaction that deleted the old generation (tx clients cannot travel
 * through DI), so the module provides this factory and the service stays
 * free of concrete retriever imports.
 */
export type TxScopedRetrieverFactory = (tx: PrismaService) => VisualRetriever;

export const PICKUP_TX_RETRIEVER_FACTORY = 'PICKUP_TX_RETRIEVER_FACTORY';
