-- Codex P1 — journey review idempotency (PR #13 blocker patch).
--
-- A review POST that succeeds while the response is lost must be safely
-- retryable: the client resends the same idempotency key and the service
-- REPLAYS the stored review instead of appending a second immutable record
-- (and a second audit row) of the same human action. The unique index is
-- the race backstop — two concurrent retries collapse to one row. NULL
-- keys stay distinct (Postgres unique semantics), so keyless reviews keep
-- plain append-only behavior.

-- AlterTable
ALTER TABLE "CustomerJourneyEventReview" ADD COLUMN "idempotencyKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "CustomerJourneyEventReview_tenantId_eventId_idempotencyKey_key" ON "CustomerJourneyEventReview"("tenantId", "eventId", "idempotencyKey");
