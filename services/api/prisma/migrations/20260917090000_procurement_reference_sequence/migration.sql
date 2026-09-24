-- Procurement reference numbering: order by an INTEGER, never by the string.
--
-- `PO-YYYY-NNNN` and `GR-YYYY-NNNN` references were allocated by reading the
-- LEXICOGRAPHICALLY largest reference for the year and incrementing the digits
-- it ended in. A string sort agrees with numeric order only while every
-- sequence is the same width. The moment `PO-2026-10000` exists,
-- `'PO-2026-9999' > 'PO-2026-10000'` (because '9' > '1'), so the lookup keeps
-- returning 9999, the allocator keeps computing 10000, the
-- (tenantId, reference) unique keeps rejecting it, and the retry recomputes the
-- same number — every further purchase order and goods receipt for that
-- tenant-year a permanent failure until the calendar year rolls over. Never
-- corrupt data; the unique index did its job. Just a hard stop, at a round
-- number, in the module that admits stock to the building.
--
-- These columns carry the year and the position within it as integers, so the
-- allocator reads a maximum from a TOTAL numeric order at every width. Widening
-- the padding would only move the same cliff to 1,000,000.
--
-- The reference string is untouched: it is still what people read on the
-- paperwork, and it is still the (tenantId, reference) unique that backstops a
-- race.

-- AlterTable
ALTER TABLE "PurchaseOrder" ADD COLUMN "referenceYear" INTEGER;
ALTER TABLE "PurchaseOrder" ADD COLUMN "referenceSequence" INTEGER;
ALTER TABLE "GoodsReceipt" ADD COLUMN "referenceYear" INTEGER;
ALTER TABLE "GoodsReceipt" ADD COLUMN "referenceSequence" INTEGER;

-- Backfill every row that already exists, so old references keep their place
-- in the ordering instead of being invisible to the allocator.
--
-- A reference in the canonical PREFIX-YYYY-NNNN shape yields its own year and
-- sequence, which is what makes this migration safe to run on a live tenant:
-- numbering CONTINUES from where it stood rather than restarting at 1 and
-- colliding with every reference already issued this year.
--
-- Anything else — a legacy import, a hand-typed number — keeps its creation
-- year and sequence 0. It contributes nothing to the maximum, which is exactly
-- how the old regex-based parser treated a non-conforming reference too.
UPDATE "PurchaseOrder" SET
  "referenceYear" = COALESCE(
    (substring("reference" from '^PO-([0-9]{4})-[0-9]+$'))::integer,
    EXTRACT(YEAR FROM "createdAt")::integer
  ),
  "referenceSequence" = COALESCE(
    (substring("reference" from '^PO-[0-9]{4}-([0-9]+)$'))::integer,
    0
  );

UPDATE "GoodsReceipt" SET
  "referenceYear" = COALESCE(
    (substring("reference" from '^GR-([0-9]{4})-[0-9]+$'))::integer,
    EXTRACT(YEAR FROM "createdAt")::integer
  ),
  "referenceSequence" = COALESCE(
    (substring("reference" from '^GR-[0-9]{4}-([0-9]+)$'))::integer,
    0
  );

-- Only now can the columns be mandatory: every existing row has a value, and
-- the application supplies both on every insert.
ALTER TABLE "PurchaseOrder" ALTER COLUMN "referenceYear" SET NOT NULL;
ALTER TABLE "PurchaseOrder" ALTER COLUMN "referenceSequence" SET NOT NULL;
ALTER TABLE "GoodsReceipt" ALTER COLUMN "referenceYear" SET NOT NULL;
ALTER TABLE "GoodsReceipt" ALTER COLUMN "referenceSequence" SET NOT NULL;

-- CreateIndex
-- The allocator's index: seek straight to this (tenant, year)'s highest
-- sequence instead of range-scanning a year of reference strings and sorting
-- them. Descending on the sequence so the answer is the first row read.
CREATE INDEX "PurchaseOrder_tenantId_referenceYear_referenceSequence_idx" ON "PurchaseOrder"("tenantId", "referenceYear", "referenceSequence" DESC);

-- CreateIndex
CREATE INDEX "GoodsReceipt_tenantId_referenceYear_referenceSequence_idx" ON "GoodsReceipt"("tenantId", "referenceYear", "referenceSequence" DESC);

-- DOMAIN CHECKS (hand-written; Prisma has no CHECK support). A sequence is a
-- position in a yearly count, so it is never negative, and a year is never
-- before the company existed. These make an out-of-band write that would
-- corrupt the ordering fail at the database rather than quietly hand the
-- allocator a maximum it cannot exceed.
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_referenceSequence_nonneg_check"
  CHECK ("referenceSequence" >= 0);
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_referenceYear_range_check"
  CHECK ("referenceYear" >= 2000);
ALTER TABLE "GoodsReceipt" ADD CONSTRAINT "GoodsReceipt_referenceSequence_nonneg_check"
  CHECK ("referenceSequence" >= 0);
ALTER TABLE "GoodsReceipt" ADD CONSTRAINT "GoodsReceipt_referenceYear_range_check"
  CHECK ("referenceYear" >= 2000);
