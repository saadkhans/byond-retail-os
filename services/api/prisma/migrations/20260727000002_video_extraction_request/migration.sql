-- Phase 10 follow-up (Codex review): extraction-request idempotency.
--
-- VideoArtifact rows are append-only, so a retried extract-frames/crop POST
-- whose original transaction committed (but whose response was lost) must
-- REPLAY the committed batch, never append a duplicate one. Each request
-- carries a tenant-scoped idempotency key; the request row (key + produced
-- artifact ids) commits in the SAME transaction as its artifact batch, and
-- the (tenantId, idempotencyKey) unique makes concurrent identical requests
-- collapse into one winner + replays. Rows store ids only — no media, no
-- storage keys.

-- CreateTable
CREATE TABLE "VideoExtractionRequest" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "videoAssetId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "artifactIds" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VideoExtractionRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VideoExtractionRequest_id_tenantId_key" ON "VideoExtractionRequest"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "VideoExtractionRequest_tenantId_idempotencyKey_key" ON "VideoExtractionRequest"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "VideoExtractionRequest_tenantId_videoAssetId_idx" ON "VideoExtractionRequest"("tenantId", "videoAssetId");

-- AddForeignKey
ALTER TABLE "VideoExtractionRequest" ADD CONSTRAINT "VideoExtractionRequest_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoExtractionRequest" ADD CONSTRAINT "VideoExtractionRequest_videoAssetId_fkey" FOREIGN KEY ("videoAssetId") REFERENCES "VideoAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

------------------------------------------------------------------------------
-- BYOND hardening (hand-written — Prisma schema cannot express these).
------------------------------------------------------------------------------

-- Cross-tenant reference integrity at the database level (same pattern as
-- the other Phase 10 tables): a request can never reference another
-- tenant's asset, even if an unscoped id slipped through application code.
ALTER TABLE "VideoExtractionRequest" ADD CONSTRAINT "VideoExtractionRequest_asset_same_tenant_fkey"
  FOREIGN KEY ("videoAssetId", "tenantId") REFERENCES "VideoAsset"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The recorded batch is evidence lineage: append-only like the artifacts it
-- indexes (one-shot rows, no exception column).
CREATE FUNCTION prevent_video_extraction_request_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'VideoExtractionRequest is append-only: % is not allowed', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER video_extraction_request_append_only
  BEFORE UPDATE OR DELETE ON "VideoExtractionRequest"
  FOR EACH ROW EXECUTE FUNCTION prevent_video_extraction_request_mutation();

CREATE TRIGGER video_extraction_request_no_truncate
  BEFORE TRUNCATE ON "VideoExtractionRequest"
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_video_extraction_request_mutation();
