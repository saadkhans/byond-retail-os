import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Pins the hand-written database hardening in migration SQL. These guarantees
 * live OUTSIDE what the Prisma schema can express, so a regenerated migration
 * could silently drop them — this spec fails if they disappear.
 */
describe('catalog & inventory migration hardening', () => {
  const sql = readFileSync(
    join(
      __dirname,
      '..',
      '..',
      'prisma',
      'migrations',
      '20260708000000_catalog_inventory',
      'migration.sql',
    ),
    'utf8',
  );

  it('makes the inventory ledger append-only at the database level', () => {
    expect(sql).toContain('CREATE FUNCTION prevent_inventory_movement_mutation()');
    expect(sql).toContain(
      'BEFORE UPDATE OR DELETE ON "InventoryMovement"',
    );
    expect(sql).toContain('BEFORE TRUNCATE ON "InventoryMovement"');
  });

  it('blocks negative stock and zero-delta movements with CHECK constraints', () => {
    expect(sql).toContain('CHECK ("quantity" >= 0)');
    expect(sql).toContain('CHECK ("quantityDelta" <> 0)');
    expect(sql).toContain('CHECK ("quantityAfter" >= 0)');
  });

  it('enforces same-tenant references with composite foreign keys', () => {
    for (const constraint of [
      'ProductCategory_parent_same_tenant_fkey',
      'Product_category_same_tenant_fkey',
      'Product_brand_same_tenant_fkey',
      'ProductBarcode_product_same_tenant_fkey',
      'InventoryLevel_location_same_tenant_fkey',
      'InventoryLevel_product_same_tenant_fkey',
      'InventoryMovement_location_same_tenant_fkey',
      'InventoryMovement_product_same_tenant_fkey',
    ]) {
      expect(sql).toContain(constraint);
    }
  });

  it('never cascades deletes into catalog or inventory tables', () => {
    expect(sql).not.toMatch(/ON DELETE (CASCADE|SET NULL)/);
  });
});

describe('checkout & orders migration hardening', () => {
  const sql = readFileSync(
    join(
      __dirname,
      '..',
      '..',
      'prisma',
      'migrations',
      '20260713000000_checkout_session_orders',
      'migration.sql',
    ),
    'utf8',
  );

  it('adds the SALE ledger type and lifecycle audit actions', () => {
    expect(sql).toContain(`ALTER TYPE "InventoryMovementType" ADD VALUE 'SALE'`);
    expect(sql).toContain(`ALTER TYPE "AuditAction" ADD VALUE 'COMPLETE'`);
    expect(sql).toContain(`ALTER TYPE "AuditAction" ADD VALUE 'CANCEL'`);
    expect(sql).toContain(`ALTER TYPE "AuditAction" ADD VALUE 'EXPIRE'`);
  });

  it('blocks non-positive line quantities and empty orders with CHECK constraints', () => {
    expect(sql).toContain('CheckoutSessionLine_quantity_positive_check');
    expect(sql).toContain('OrderLine_quantity_positive_check');
    expect(sql).toContain('Order_totalQuantity_positive_check');
    expect(sql).toContain('CHECK ("quantity" >= 1)');
    expect(sql).toContain('CHECK ("totalQuantity" >= 1)');
  });

  it('constrains evidence scores to normalized [0, 1] confidences', () => {
    for (const constraint of [
      'CheckoutSession_evidenceScore_range_check',
      'CheckoutSessionLine_evidenceScore_range_check',
      'Order_evidenceScore_range_check',
      'OrderLine_evidenceScore_range_check',
    ]) {
      expect(sql).toContain(constraint);
    }
    expect(sql).toContain(
      '"evidenceScore" IS NULL OR ("evidenceScore" >= 0 AND "evidenceScore" <= 1)',
    );
  });

  it('enforces same-tenant references with composite foreign keys', () => {
    for (const constraint of [
      'CheckoutSession_location_same_tenant_fkey',
      'CheckoutSession_unit_same_tenant_fkey',
      'CheckoutSession_device_same_tenant_fkey',
      'CheckoutSessionLine_session_same_tenant_fkey',
      'CheckoutSessionLine_product_same_tenant_fkey',
      'Order_session_same_tenant_fkey',
      'Order_location_same_tenant_fkey',
      'Order_unit_same_tenant_fkey',
      'OrderLine_order_same_tenant_fkey',
      'OrderLine_product_same_tenant_fkey',
      'OrderLine_sessionLine_same_tenant_fkey',
    ]) {
      expect(sql).toContain(constraint);
    }
  });

  it('keeps order numbers and idempotency keys unique per tenant', () => {
    expect(sql).toContain('Order_tenantId_orderNumber_key');
    expect(sql).toContain('Order_tenantId_idempotencyKey_key');
    expect(sql).toContain('CheckoutSession_tenantId_idempotencyKey_key');
    expect(sql).toContain('CheckoutSessionLine_tenantId_idempotencyKey_key');
  });

  it('never cascades deletes into checkout or order tables', () => {
    expect(sql).not.toMatch(/ON DELETE (CASCADE|SET NULL)/);
  });
});

describe('checkout module backfill migration', () => {
  const sql = readFileSync(
    join(
      __dirname,
      '..',
      '..',
      'prisma',
      'migrations',
      '20260713000001_checkout_module_backfill',
      'migration.sql',
    ),
    'utf8',
  );

  it('activates a pre-existing checkout module row instead of leaving it inactive', () => {
    // Databases seeded BEFORE Phase 5 can already carry the `checkout` row
    // with isActive=false; DO NOTHING would leave every tenant 403ing even
    // with enablement rows. The upsert must refresh the catalog fields and
    // force activation while PRESERVING the existing row's id.
    expect(sql).toContain('ON CONFLICT ("code") DO UPDATE SET');
    expect(sql).toContain('"name" = EXCLUDED."name"');
    expect(sql).toContain('"description" = EXCLUDED."description"');
    expect(sql).toContain('"isActive" = true');
    // The conflict target is the unique `code` — the update path never
    // inserts a second row or touches the conflicting row's "id".
    expect(sql).not.toMatch(/DO UPDATE SET[^;]*"id"\s*=/);
  });

  it('is idempotent and never overwrites a tenant admin choice', () => {
    // Tenant enablement stays DO NOTHING: re-running must not overwrite a
    // row a tenant admin already created or disabled; the module upsert
    // converges on the same catalog values on every run.
    expect(sql).toContain('ON CONFLICT ("tenantId", "moduleId") DO NOTHING');
    expect(sql).not.toMatch(/ON CONFLICT \("tenantId", "moduleId"\) DO UPDATE/);
  });

  it('enables checkout for every pre-existing tenant with deterministic ids', () => {
    expect(sql).toContain(`'tm-' || md5(t."id" || ':checkout')`);
    expect(sql).toContain(`WHERE pm."code" = 'checkout'`);
  });
});

describe('payments & reconciliation migration hardening', () => {
  const sql = readFileSync(
    join(
      __dirname,
      '..',
      '..',
      'prisma',
      'migrations',
      '20260716000000_payments_reconciliation',
      'migration.sql',
    ),
    'utf8',
  );

  it('adds the payment-lifecycle audit actions', () => {
    for (const action of ['AUTHORIZE', 'CAPTURE', 'VOID', 'FAIL', 'RECONCILE']) {
      expect(sql).toContain(`ALTER TYPE "AuditAction" ADD VALUE '${action}'`);
    }
  });

  it('keeps money non-negative and a capture within its authorization', () => {
    expect(sql).toContain('PaymentIntent_amountMinor_nonneg_check');
    expect(sql).toContain('PaymentAuthorization_amountMinor_nonneg_check');
    expect(sql).toContain('PaymentCapture_amountMinor_nonneg_check');
    expect(sql).toContain('PaymentIntent_capturedAmount_range_check');
    expect(sql).toContain(
      'CHECK ("capturedAmountMinor" >= 0 AND "capturedAmountMinor" <= "amountMinor")',
    );
  });

  it('stores only SAFE card metadata: last4 is exactly four digits', () => {
    expect(sql).toContain('PaymentIntent_instrumentLast4_format_check');
    expect(sql).toContain(`CHECK ("instrumentLast4" IS NULL OR "instrumentLast4" ~ '^[0-9]{4}$')`);
    expect(sql).toContain('PaymentIntent_instrumentExpiryMonth_range_check');
    expect(sql).toContain('PaymentIntent_instrumentExpiryYear_range_check');
  });

  it('deduplicates provider events per tenant/provider', () => {
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "PaymentEvent_tenantId_provider_providerEventId_key"',
    );
  });

  it('keeps idempotency keys unique per tenant on every mutating table', () => {
    expect(sql).toContain('PaymentIntent_tenantId_idempotencyKey_key');
    expect(sql).toContain('PaymentAuthorization_tenantId_idempotencyKey_key');
    expect(sql).toContain('PaymentCapture_tenantId_idempotencyKey_key');
    expect(sql).toContain('PaymentEvent_tenantId_idempotencyKey_key');
  });

  it('enforces same-tenant references with composite foreign keys', () => {
    for (const constraint of [
      'PaymentIntent_order_same_tenant_fkey',
      'PaymentIntent_session_same_tenant_fkey',
      'PaymentAuthorization_intent_same_tenant_fkey',
      'PaymentCapture_intent_same_tenant_fkey',
      'PaymentEvent_intent_same_tenant_fkey',
      'PaymentReconciliationRecord_intent_same_tenant_fkey',
      'PaymentReconciliationRecord_capture_same_tenant_fkey',
    ]) {
      expect(sql).toContain(constraint);
    }
  });

  it('backs the Prisma captureId relation with a single-column FK', () => {
    // The schema now models `capture PaymentCapture?` on
    // PaymentReconciliationRecord; the migration must already create the
    // matching FK so the relation aligns with the database.
    expect(sql).toContain(
      'ADD CONSTRAINT "PaymentReconciliationRecord_captureId_fkey"',
    );
    expect(sql).toContain(
      'FOREIGN KEY ("captureId") REFERENCES "PaymentCapture"("id")',
    );
  });

  it('never cascades deletes into payment tables', () => {
    expect(sql).not.toMatch(/ON DELETE (CASCADE|SET NULL)/);
  });
});

describe('payments module backfill migration', () => {
  const sql = readFileSync(
    join(
      __dirname,
      '..',
      '..',
      'prisma',
      'migrations',
      '20260716000001_payments_module_backfill',
      'migration.sql',
    ),
    'utf8',
  );

  it('activates a pre-existing payments module row instead of leaving it inactive', () => {
    expect(sql).toContain('ON CONFLICT ("code") DO UPDATE SET');
    expect(sql).toContain('"isActive" = true');
    expect(sql).not.toMatch(/DO UPDATE SET[^;]*"id"\s*=/);
  });

  it('is idempotent and never overwrites a tenant admin choice', () => {
    expect(sql).toContain('ON CONFLICT ("tenantId", "moduleId") DO NOTHING');
    expect(sql).not.toMatch(/ON CONFLICT \("tenantId", "moduleId"\) DO UPDATE/);
  });

  it('enables payments for every pre-existing tenant with deterministic ids', () => {
    expect(sql).toContain(`'tm-' || md5(t."id" || ':payments')`);
    expect(sql).toContain(`WHERE pm."code" = 'payments'`);
  });

  it('backfills the payment permission catalog rows (migrate deploy runs without seed)', () => {
    for (const code of [
      'payment:read',
      'payment:manage',
      'payment:simulate',
      'reconciliation:read',
      'reconciliation:manage',
    ]) {
      expect(sql).toContain(`'${code}'`);
    }
    expect(sql).toContain('ON CONFLICT ("code") DO UPDATE SET');
  });
});

describe('inference migration hardening', () => {
  const sql = readFileSync(
    join(
      __dirname,
      '..',
      '..',
      'prisma',
      'migrations',
      '20260726000000_inference',
      'migration.sql',
    ),
    'utf8',
  );

  it('makes adapter output append-only at the database level', () => {
    expect(sql).toContain('CREATE FUNCTION prevent_inference_result_mutation()');
    expect(sql).toContain('BEFORE UPDATE OR DELETE ON "InferenceResult"');
    expect(sql).toContain('BEFORE TRUNCATE ON "InferenceResult"');
    expect(sql).toContain(
      'CREATE FUNCTION prevent_inference_candidate_mutation()',
    );
    expect(sql).toContain('BEFORE UPDATE OR DELETE ON "InferenceCandidate"');
    expect(sql).toContain('BEFORE TRUNCATE ON "InferenceCandidate"');
  });

  it('constrains priorities, deltas, scores, and ranks with CHECK constraints', () => {
    expect(sql).toContain('InferenceJob_priority_range_check');
    expect(sql).toContain('CHECK ("priority" >= 0 AND "priority" <= 1000)');
    expect(sql).toContain('InferenceJob_attempts_nonnegative_check');
    expect(sql).toContain('CHECK ("attempts" >= 0)');
    expect(sql).toContain('InferenceResult_quantityDelta_nonzero_check');
    expect(sql).toContain('CHECK ("quantityDelta" <> 0)');
    expect(sql).toContain('InferenceResult_return_direction_check');
    expect(sql).toContain(
      `CHECK (("quantityDelta" < 0) = ("eventType" = 'PRODUCT_RETURN'))`,
    );
    expect(sql).toContain('InferenceResult_evidenceScore_range_check');
    expect(sql).toContain('InferenceCandidate_rank_positive_check');
    expect(sql).toContain('InferenceCandidate_score_range_check');
  });

  it('keeps lifecycle timestamps and error codes coherent with the status', () => {
    for (const constraint of [
      'InferenceJob_queued_timestamps_check',
      'InferenceJob_running_timestamps_check',
      'InferenceJob_succeeded_timestamps_check',
      'InferenceJob_terminal_completedAt_check',
      'InferenceJob_error_only_failed_check',
      'InferenceJob_visionEvent_succeeded_check',
    ]) {
      expect(sql).toContain(constraint);
    }
  });

  it('ties the queue lease to the RUNNING status at the database level', () => {
    expect(sql).toContain('InferenceJob_running_lease_check');
    expect(sql).toContain(
      `CHECK (("status" = 'RUNNING') = ("leaseExpiresAt" IS NOT NULL))`,
    );
  });

  it('stores the source-reported occurrence time on every result', () => {
    expect(sql).toContain('"occurredAt" TIMESTAMP(3) NOT NULL');
  });

  it('enforces same-tenant references with composite foreign keys', () => {
    for (const constraint of [
      'InferenceJob_location_same_tenant_fkey',
      'InferenceJob_unit_same_tenant_fkey',
      'InferenceJob_device_same_tenant_fkey',
      'InferenceJob_session_same_tenant_fkey',
      'InferenceJob_visionEvent_same_tenant_fkey',
      'InferenceJob_creator_same_tenant_fkey',
      'InferenceResult_job_same_tenant_fkey',
      'InferenceCandidate_result_same_tenant_fkey',
    ]) {
      expect(sql).toContain(constraint);
    }
    // The creator FK needs its composite anchor on User.
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "User_id_tenantId_key" ON "User"("id", "tenantId")',
    );
  });

  it('keeps idempotency keys unique per tenant and the claim ordering indexed', () => {
    expect(sql).toContain('InferenceJob_tenantId_idempotencyKey_key');
    expect(sql).toContain(
      'InferenceJob_tenantId_status_priority_requestedAt_id_idx',
    );
  });

  it('never cascades deletes into inference tables', () => {
    expect(sql).not.toMatch(/ON DELETE (CASCADE|SET NULL)/);
  });
});

describe('inference module backfill migration', () => {
  const sql = readFileSync(
    join(
      __dirname,
      '..',
      '..',
      'prisma',
      'migrations',
      '20260726000001_inference_module_backfill',
      'migration.sql',
    ),
    'utf8',
  );

  it('activates a pre-existing inference module row instead of leaving it inactive', () => {
    expect(sql).toContain('ON CONFLICT ("code") DO UPDATE SET');
    expect(sql).toContain('"isActive" = true');
    expect(sql).not.toMatch(/DO UPDATE SET[^;]*"id"\s*=/);
  });

  it('is idempotent and never overwrites a tenant admin choice', () => {
    expect(sql).toContain('ON CONFLICT ("tenantId", "moduleId") DO NOTHING');
    expect(sql).not.toMatch(/ON CONFLICT \("tenantId", "moduleId"\) DO UPDATE/);
  });

  it('enables inference for every pre-existing tenant with deterministic ids', () => {
    expect(sql).toContain(`'tm-' || md5(t."id" || ':inference')`);
    expect(sql).toContain(`WHERE pm."code" = 'inference'`);
  });

  it('backfills the inference permission catalog rows (migrate deploy runs without seed)', () => {
    for (const code of [
      'inference:read',
      'inference:manage',
      'inference:simulate',
      'inference:apply',
    ]) {
      expect(sql).toContain(`'${code}'`);
    }
  });
});

describe('checkout line soft-delete migration hardening', () => {
  const sql = readFileSync(
    join(
      __dirname,
      '..',
      '..',
      'prisma',
      'migrations',
      '20260714000000_checkout_line_soft_delete',
      'migration.sql',
    ),
    'utf8',
  );

  it('replaces the per-product unique with a PARTIAL unique over ACTIVE lines', () => {
    // Tombstones must be exempt from "one line per product per session", or
    // a product could never be re-added after a removal — while ACTIVE lines
    // keep the aggregate-into-updates guarantee.
    expect(sql).toContain(
      'DROP INDEX "CheckoutSessionLine_tenantId_sessionId_productId_key"',
    );
    expect(sql).toContain('CheckoutSessionLine_active_product_key');
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "CheckoutSessionLine_active_product_key"[\s\S]*WHERE "status" = 'ACTIVE'/,
    );
  });

  it('keeps removed-line tombstones honest with a CHECK constraint', () => {
    expect(sql).toContain('CheckoutSessionLine_removed_has_timestamp_check');
    expect(sql).toContain(
      `CHECK (("status" = 'REMOVED') = ("removedAt" IS NOT NULL))`,
    );
  });

  it('never drops or cascades over line rows (idempotency keys stay reserved)', () => {
    // The (tenantId, idempotencyKey) unique from the Phase 5 migration is
    // untouched, and nothing here deletes rows — the tombstone IS the
    // reservation.
    expect(sql).not.toMatch(/DROP INDEX "CheckoutSessionLine_tenantId_idempotencyKey_key"/);
    expect(sql).not.toMatch(/DELETE FROM/);
    expect(sql).not.toMatch(/ON DELETE (CASCADE|SET NULL)/);
  });
});

describe('video ingest migration hardening', () => {
  const sql = readFileSync(
    join(
      __dirname,
      '..',
      '..',
      'prisma',
      'migrations',
      '20260727000000_video_ingest',
      'migration.sql',
    ),
    'utf8',
  );

  it('makes extraction artifacts append-only (one-shot inference link excepted)', () => {
    expect(sql).toContain('CREATE FUNCTION prevent_video_artifact_mutation()');
    expect(sql).toContain('BEFORE UPDATE OR DELETE ON "VideoArtifact"');
    expect(sql).toContain('BEFORE TRUNCATE ON "VideoArtifact"');
    // The single allowed mutation: setting inferenceJobId on a row that does
    // not carry one yet, with every other column bit-identical.
    expect(sql).toContain('OLD."inferenceJobId" IS NULL');
    expect(sql).toContain('NEW."inferenceJobId" IS NOT NULL');
    expect(sql).toContain('NEW."checksumSha256" = OLD."checksumSha256"');
    expect(sql).toContain('NEW."storageKey" = OLD."storageKey"');
  });

  it('constrains sizes, probed metadata, and crop boxes with CHECK constraints', () => {
    expect(sql).toContain('VideoAsset_sizeBytes_positive_check');
    expect(sql).toContain('CHECK ("sizeBytes" > 0)');
    expect(sql).toContain('VideoAsset_durationMs_positive_check');
    expect(sql).toContain('VideoAsset_dimensions_positive_check');
    expect(sql).toContain('VideoAsset_fps_positive_check');
    expect(sql).toContain('VideoArtifact_sizeBytes_positive_check');
    expect(sql).toContain('VideoArtifact_timestampMs_nonnegative_check');
    expect(sql).toContain('VideoArtifact_dimensions_positive_check');
    // A CROP always carries a complete, in-range crop box; a FRAME never
    // carries one.
    expect(sql).toContain('VideoArtifact_crop_box_check');
    expect(sql).toContain(`"artifactType" = 'CROP' AND "cropX" IS NOT NULL`);
    expect(sql).toContain(`"artifactType" = 'FRAME' AND "cropX" IS NULL`);
  });

  it('keeps error codes coherent with terminal statuses', () => {
    expect(sql).toContain('VideoAsset_error_only_terminal_check');
    expect(sql).toContain(
      `CHECK (("errorCode" IS NOT NULL) = ("status" IN ('REJECTED', 'FAILED')))`,
    );
  });

  it('enforces same-tenant references with composite foreign keys', () => {
    for (const constraint of [
      'VideoAsset_location_same_tenant_fkey',
      'VideoAsset_unit_same_tenant_fkey',
      'VideoAsset_device_same_tenant_fkey',
      'VideoAsset_session_same_tenant_fkey',
      'VideoAsset_uploader_same_tenant_fkey',
      'VideoArtifact_asset_same_tenant_fkey',
      'VideoArtifact_job_same_tenant_fkey',
      'VideoArtifact_creator_same_tenant_fkey',
    ]) {
      expect(sql).toContain(constraint);
    }
  });

  it('stores internal storage keys and checksums, never URLs', () => {
    expect(sql).toContain('"storageKey" TEXT NOT NULL');
    expect(sql).toContain('"checksumSha256" TEXT NOT NULL');
    // No public/signed URL columns exist in the video tables (comments may
    // mention URLs; quoted identifiers must not).
    expect(sql).not.toMatch(/"[^"\n]*url[^"\n]*"/i);
  });

  it('never cascades deletes into video tables', () => {
    expect(sql).not.toMatch(/ON DELETE (CASCADE|SET NULL)/);
  });
});

describe('video ingest module backfill migration', () => {
  const sql = readFileSync(
    join(
      __dirname,
      '..',
      '..',
      'prisma',
      'migrations',
      '20260727000001_video_ingest_module_backfill',
      'migration.sql',
    ),
    'utf8',
  );

  it('activates a pre-existing video-ingest module row instead of leaving it inactive', () => {
    expect(sql).toContain('ON CONFLICT ("code") DO UPDATE SET');
    expect(sql).toContain('"isActive" = true');
    expect(sql).not.toMatch(/DO UPDATE SET[^;]*"id"\s*=/);
  });

  it('is idempotent and never overwrites a tenant admin choice', () => {
    expect(sql).toContain('ON CONFLICT ("tenantId", "moduleId") DO NOTHING');
    expect(sql).not.toMatch(/ON CONFLICT \("tenantId", "moduleId"\) DO UPDATE/);
  });

  it('enables video-ingest for every pre-existing tenant with deterministic ids', () => {
    expect(sql).toContain(`'tm-' || md5(t."id" || ':video-ingest')`);
    expect(sql).toContain(`WHERE pm."code" = 'video-ingest'`);
  });

  it('backfills the video-asset permission catalog rows (migrate deploy runs without seed)', () => {
    for (const code of [
      'video-asset:read',
      'video-asset:manage',
      'video-asset:process',
      'video-asset:delete',
    ]) {
      expect(sql).toContain(`'${code}'`);
    }
  });
});

describe('video extraction request migration', () => {
  const sql = readFileSync(
    join(
      __dirname,
      '..',
      '..',
      'prisma',
      'migrations',
      '20260727000002_video_extraction_request',
      'migration.sql',
    ),
    'utf8',
  );

  it('makes extraction requests replayable via a tenant-scoped unique key', () => {
    expect(sql).toContain('VideoExtractionRequest_tenantId_idempotencyKey_key');
    expect(sql).toContain(
      'ON "VideoExtractionRequest"("tenantId", "idempotencyKey")',
    );
  });

  it('enforces same-tenant asset references with a composite foreign key', () => {
    expect(sql).toContain('VideoExtractionRequest_asset_same_tenant_fkey');
  });

  it('is append-only at the database level', () => {
    expect(sql).toContain(
      'CREATE FUNCTION prevent_video_extraction_request_mutation()',
    );
    expect(sql).toContain('BEFORE UPDATE OR DELETE ON "VideoExtractionRequest"');
    expect(sql).toContain('BEFORE TRUNCATE ON "VideoExtractionRequest"');
  });

  it('stores ids only and never cascades deletes', () => {
    // No media, storage-key, or URL columns exist on the request table.
    expect(sql).not.toMatch(/"[^"\n]*(storageKey|url|media)[^"\n]*" TEXT/i);
    expect(sql).not.toMatch(/ON DELETE (CASCADE|SET NULL)/);
  });
});

describe('video asset quarantine screening migration', () => {
  const sql = readFileSync(
    join(
      __dirname,
      '..',
      '..',
      'prisma',
      'migrations',
      '20260727000004_video_asset_quarantine_screening',
      'migration.sql',
    ),
    'utf8',
  );

  it('adds the QUARANTINED lifecycle value idempotently', () => {
    expect(sql).toContain(
      `ALTER TYPE "VideoAssetStatus" ADD VALUE IF NOT EXISTS 'QUARANTINED'`,
    );
  });

  it('never USES the new enum value in the same transaction (PG 12+ rule)', () => {
    // ADD VALUE inside a transaction is legal only while the new value is
    // unused within it: no column default flip, no CHECK, no UPDATE here —
    // the repository sets QUARANTINED explicitly at create time instead.
    expect(sql).not.toMatch(/DEFAULT 'QUARANTINED'/);
    expect(sql).not.toMatch(/UPDATE\s+"VideoAsset"/i);
    expect(sql).not.toMatch(/ADD CONSTRAINT[^;]*QUARANTINED/);
  });

  it('backfills the screening permission (migrate deploy runs without seed)', () => {
    expect(sql).toContain(`'video-asset:screen'`);
    expect(sql).toContain('ON CONFLICT ("code") DO UPDATE SET');
    expect(sql).not.toMatch(/DO UPDATE SET[^;]*"id"\s*=/);
  });
});

describe('inference job pending-link migration', () => {
  const sql = readFileSync(
    join(
      __dirname,
      '..',
      '..',
      'prisma',
      'migrations',
      '20260729000001_inference_job_pending_link',
      'migration.sql',
    ),
    'utf8',
  );

  it('adds the PENDING_LINK lifecycle value idempotently, ahead of QUEUED', () => {
    expect(sql).toContain(
      `ALTER TYPE "InferenceJobStatus" ADD VALUE IF NOT EXISTS 'PENDING_LINK' BEFORE 'QUEUED'`,
    );
  });

  it('never USES the new enum value in the same transaction (PG 12+ rule)', () => {
    // ADD VALUE inside a transaction is legal only while the new value is
    // unused within it: no column default flip, no UPDATE, and no CHECK
    // constraint may NAME 'PENDING_LINK' here — the queue writes the status
    // explicitly on the opt-in create path instead.
    expect(sql).not.toMatch(/DEFAULT 'PENDING_LINK'/);
    expect(sql).not.toMatch(/UPDATE\s+"InferenceJob"/i);
    expect(sql).not.toMatch(/ADD CONSTRAINT[^;]*PENDING_LINK/);
  });

  it('keeps unclaimed jobs timestamp-free by listing the STARTED statuses instead', () => {
    // The old guard named QUEUED, so PENDING_LINK would have escaped it;
    // naming the complement covers the new state without using its value.
    expect(sql).toContain(
      'ALTER TABLE "InferenceJob" DROP CONSTRAINT "InferenceJob_queued_timestamps_check"',
    );
    expect(sql).toContain('InferenceJob_unclaimed_timestamps_check');
    expect(sql).toContain(
      `CHECK ("status" IN ('RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED')`,
    );
    expect(sql).toContain('"startedAt" IS NULL AND "completedAt" IS NULL');
  });

  it('leaves every other InferenceJob lifecycle CHECK untouched', () => {
    // PENDING_LINK is NON-TERMINAL and carries no error, lease, or vision
    // link, so the remaining guards already hold for it.
    for (const constraint of [
      'InferenceJob_terminal_completedAt_check',
      'InferenceJob_error_only_failed_check',
      'InferenceJob_running_lease_check',
      'InferenceJob_visionEvent_succeeded_check',
    ]) {
      expect(sql).not.toContain(constraint);
    }
  });
});

describe('video asset media-write state migration', () => {
  const sql = readFileSync(
    join(
      __dirname,
      '..',
      '..',
      'prisma',
      'migrations',
      '20260729000002_video_asset_media_write_state',
      'migration.sql',
    ),
    'utf8',
  );

  it('adds the media-write state enum and a NULLABLE column on VideoAsset', () => {
    expect(sql).toContain(
      `CREATE TYPE "VideoMediaWriteState" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED')`,
    );
    expect(sql).toContain(
      'ALTER TABLE "VideoAsset" ADD COLUMN "mediaWriteState" "VideoMediaWriteState"',
    );
    // NULLABLE and undefaulted on purpose: NULL means "no durable media
    // write was ever attempted", which is the honest reading for existing
    // rows and for uploads rejected before their put.
    expect(sql).not.toMatch(/"mediaWriteState"[^;]*NOT NULL/);
    expect(sql).not.toMatch(/"mediaWriteState"[^;]*DEFAULT/);
  });

  it('backfills NOTHING — existing rows keep byte-identical delete behaviour', () => {
    // Only PENDING withholds the media-removal completion, so leaving
    // every existing row NULL cannot change what any delete records.
    expect(sql).not.toMatch(/UPDATE\s+"VideoAsset"/i);
  });
});

describe('cv same-tenant fk migration hardening', () => {
  // The pickup-validation, fusion-v2, and journey-skeleton migrations
  // shipped their tables with single-column FKs only; this migration adds
  // the composite same-tenant FKs that are the database-level
  // tenant-isolation guarantee (AGENTS.md: tenancy).
  const sql = readFileSync(
    join(
      __dirname,
      '..',
      '..',
      'prisma',
      'migrations',
      '20260811110000_cv_same_tenant_fks',
      'migration.sql',
    ),
    'utf8',
  );

  it('anchors the two newly-referenced parents with UNIQUE (id, tenantId)', () => {
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "CustomerJourney_id_tenantId_key" ON "CustomerJourney"("id", "tenantId")',
    );
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "ProductReferenceImage_id_tenantId_key" ON "ProductReferenceImage"("id", "tenantId")',
    );
  });

  it('enforces same-tenant references with composite foreign keys on every CV table', () => {
    for (const [constraint, columns, parent] of [
      ['CustomerJourney_location_same_tenant_fkey', '"locationId", "tenantId"', 'Location'],
      ['CustomerJourney_unit_same_tenant_fkey', '"unitId", "tenantId"', 'RetailUnit'],
      ['CustomerJourneyEvent_journey_same_tenant_fkey', '"journeyId", "tenantId"', 'CustomerJourney'],
      ['CustomerJourneyEvent_product_same_tenant_fkey', '"productId", "tenantId"', 'Product'],
      ['ProductReferenceImage_product_same_tenant_fkey', '"productId", "tenantId"', 'Product'],
      ['VideoGroundTruth_videoAsset_same_tenant_fkey', '"videoAssetId", "tenantId"', 'VideoAsset'],
      ['VideoGroundTruth_product_same_tenant_fkey', '"productId", "tenantId"', 'Product'],
      ['ProductReferenceEmbedding_product_same_tenant_fkey', '"productId", "tenantId"', 'Product'],
      ['ProductReferenceEmbedding_referenceImage_same_tenant_fkey', '"referenceImageId", "tenantId"', 'ProductReferenceImage'],
      ['PickupFusionRun_videoAsset_same_tenant_fkey', '"videoAssetId", "tenantId"', 'VideoAsset'],
    ] as const) {
      expect(sql).toContain(
        `ADD CONSTRAINT "${constraint}" FOREIGN KEY (${columns}) REFERENCES "${parent}"("id", "tenantId")`,
      );
    }
  });

  it('mirrors each sibling single-column FK action — cascades ONLY with the owning lifecycle', () => {
    // A composite RESTRICT beside a single-column CASCADE would silently
    // veto the cascade the Prisma schema promises, so the three
    // child-lifecycle FKs cascade and everything else restricts.
    const cascading = [
      'CustomerJourneyEvent_journey_same_tenant_fkey',
      'VideoGroundTruth_videoAsset_same_tenant_fkey',
      'ProductReferenceEmbedding_referenceImage_same_tenant_fkey',
      'PickupFusionRun_videoAsset_same_tenant_fkey',
    ];
    for (const line of sql.split('\n')) {
      if (!line.includes('ADD CONSTRAINT')) continue;
      const expectsCascade = cascading.some((name) => line.includes(name));
      expect(line).toContain(
        expectsCascade
          ? 'ON DELETE CASCADE ON UPDATE CASCADE'
          : 'ON DELETE RESTRICT ON UPDATE CASCADE',
      );
    }
  });

  it('never covers User references with composite FKs (platform-sandbox exception)', () => {
    // createdById rows written by platform admins carry (platform user,
    // sandbox tenant) — a pair that can never exist in User(id, tenantId).
    expect(sql).not.toMatch(/REFERENCES "User"/);
    expect(sql).not.toMatch(/"createdById"/);
  });
});

describe('store flow migration hardening', () => {
  const migrationsDir = join(__dirname, '..', '..', 'prisma', 'migrations');
  const sql = readFileSync(
    join(migrationsDir, '20260916100000_phase26_store_loop', 'migration.sql'),
    'utf8',
  );
  const schema = readFileSync(
    join(__dirname, '..', '..', 'prisma', 'schema.prisma'),
    'utf8',
  );
  // The hand-written statements are wrapped across lines for readability;
  // compare against a whitespace-normalized copy so formatting is never
  // load-bearing.
  const flat = sql.replace(/\s+/g, ' ');

  /** The column names one model declares in schema.prisma. */
  const schemaColumns = (model: string): string[] => {
    const body = schema.match(
      new RegExp(`\\r?\\nmodel ${model} \\{\\r?\\n([\\s\\S]*?)\\r?\\n\\}`),
    );
    expect(body).not.toBeNull();
    return body![1]
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(
        (line) =>
          line.length > 0 &&
          !line.startsWith('//') &&
          !line.startsWith('@@') &&
          // Relation fields and list fields carry no column of their own.
          !/^\w+\s+\w+(\[\])?\??\s+@relation/.test(line) &&
          !/^\w+\s+\w+\[\]/.test(line),
      )
      .map((line) => line.split(/\s+/)[0])
      .filter((name) => /^[a-z]/.test(name));
  };

  /** The column names one CREATE TABLE declares in the migration. */
  const migrationColumns = (table: string): string[] => {
    const body = sql.match(
      new RegExp(`CREATE TABLE "${table}" \\(\\r?\\n([\\s\\S]*?)\\r?\\n\\);`),
    );
    expect(body).not.toBeNull();
    return [...body![1].matchAll(/^ {4}"([A-Za-z0-9_]+)"/gm)].map(
      (match) => match[1],
    );
  };

  it('creates exactly the columns schema.prisma declares, for every new table', () => {
    // This repo hand-writes migration SQL, so nothing else catches a column
    // that exists in the Prisma model and not in the database.
    for (const model of [
      'Shopper',
      'StoreEntryToken',
      'StoreFlowPolicy',
      'StoreFlowPolicyVersion',
      'StoreFlowProjection',
    ]) {
      expect([model, migrationColumns(model).sort()]).toEqual([
        model,
        schemaColumns(model).sort(),
      ]);
    }
  });

  it('adds the four commerce columns a journey was missing, all back-compatible', () => {
    // Every one is nullable or defaulted, so the migration cannot fail on a
    // table that already has rows, and pre-Phase-26 journeys keep their shape.
    expect(flat).toContain(
      'ALTER TABLE "CustomerJourney" ADD COLUMN "checkoutSessionId" TEXT,',
    );
    expect(flat).toContain('ADD COLUMN "orderId" TEXT,');
    expect(flat).toContain('ADD COLUMN "shopperId" TEXT;');
    expect(flat).toContain(
      'ADD COLUMN "settlementStatus" "StoreFlowSettlementStatus" NOT NULL DEFAULT \'NOT_STARTED\'',
    );
  });

  it('ships the enum values the code depends on, and defaults to SHADOW', () => {
    expect(sql).toContain(
      `CREATE TYPE "StoreFlowAutonomyLevel" AS ENUM ('SHADOW', 'PROPOSE', 'AUTO_APPLY')`,
    );
    expect(sql).toContain(
      `CREATE TYPE "StoreFlowProjectionOutcome" AS ENUM ('SKIPPED', 'PROPOSED', 'AUTO_APPLIED', 'REVIEW_REQUIRED', 'REJECTED')`,
    );
    expect(sql).toContain(
      `CREATE TYPE "StoreFlowSettlementStatus" AS ENUM ('NOT_STARTED', 'BLOCKED_ON_REVIEW', 'ORDER_CREATED', 'PAID', 'FAILED')`,
    );
    expect(sql).toContain(
      `CREATE TYPE "StoreEntryTokenStatus" AS ENUM ('ISSUED', 'REDEEMED', 'REVOKED')`,
    );
    // The default the Prisma schema promises has to be the database's too, or
    // a row written outside the service could arrive already autonomous.
    expect(sql).toContain(
      `"autonomyLevel" "StoreFlowAutonomyLevel" NOT NULL DEFAULT 'SHADOW'`,
    );
    expect(sql).toContain(`"settleOnExit" BOOLEAN NOT NULL DEFAULT false`);
    expect(sql).toContain(
      `"requireInventoryValidation" BOOLEAN NOT NULL DEFAULT true`,
    );
  });

  it('enforces same-tenant references with composite foreign keys', () => {
    for (const [constraint, columns, parent] of [
      ['CustomerJourney_shopper_same_tenant_fkey', '"shopperId", "tenantId"', 'Shopper'],
      ['CustomerJourney_session_same_tenant_fkey', '"checkoutSessionId", "tenantId"', 'CheckoutSession'],
      ['CustomerJourney_order_same_tenant_fkey', '"orderId", "tenantId"', 'Order'],
      ['StoreEntryToken_location_same_tenant_fkey', '"locationId", "tenantId"', 'Location'],
      ['StoreEntryToken_unit_same_tenant_fkey', '"unitId", "tenantId"', 'RetailUnit'],
      ['StoreEntryToken_shopper_same_tenant_fkey', '"shopperId", "tenantId"', 'Shopper'],
      ['StoreEntryToken_journey_same_tenant_fkey', '"redeemedJourneyId", "tenantId"', 'CustomerJourney'],
      ['StoreFlowPolicy_location_same_tenant_fkey', '"locationId", "tenantId"', 'Location'],
      ['StoreFlowPolicy_active_version_same_tenant_fkey', '"activeVersionId", "tenantId"', 'StoreFlowPolicyVersion'],
      ['StoreFlowPolicyVersion_policy_same_tenant_fkey', '"policyId", "tenantId"', 'StoreFlowPolicy'],
      ['StoreFlowProjection_journey_same_tenant_fkey', '"journeyId", "tenantId"', 'CustomerJourney'],
      ['StoreFlowProjection_event_same_tenant_fkey', '"journeyEventId", "tenantId"', 'CustomerJourneyEvent'],
      ['StoreFlowProjection_vision_event_same_tenant_fkey', '"visionEventId", "tenantId"', 'VisionEvent'],
    ] as const) {
      expect(flat).toContain(
        `ADD CONSTRAINT "${constraint}" FOREIGN KEY (${columns}) REFERENCES "${parent}"("id", "tenantId")`,
      );
    }
  });

  it('never covers User references with composite FKs (platform-sandbox exception)', () => {
    // Same reason as the CV migration: a platform admin acting in the sandbox
    // tenant is a (platform user, sandbox tenant) pair that User(id, tenantId)
    // can never hold.
    expect(flat).not.toMatch(
      /same_tenant_fkey" FOREIGN KEY \("(issuedById|createdById|userId)"/,
    );
  });

  it('keeps at most one tenant-wide default policy per tenant', () => {
    // Postgres treats NULLs as distinct, so the (tenantId, locationId) unique
    // index alone would let a tenant collect several tenant-wide rows and
    // resolve to an arbitrary one.
    expect(flat).toContain(
      'CREATE UNIQUE INDEX "StoreFlowPolicy_tenant_default_key" ON "StoreFlowPolicy"("tenantId") WHERE "locationId" IS NULL',
    );
  });

  it('refuses to store anything but a SHA-256 digest for an entry credential', () => {
    expect(flat).toContain(
      `ADD CONSTRAINT "StoreEntryToken_token_hash_is_sha256" CHECK ("tokenHash" ~ '^[0-9a-f]{64}$')`,
    );
    expect(flat).toContain(
      `ADD CONSTRAINT "StoreEntryToken_expiry_after_issue" CHECK ("expiresAt" > "createdAt")`,
    );
  });

  it('keeps a credential status and its evidence together', () => {
    expect(flat).toContain('"StoreEntryToken_status_evidence"');
    for (const clause of [
      `"status" = 'ISSUED' AND "redeemedAt" IS NULL AND "redeemedJourneyId" IS NULL AND "revokedAt" IS NULL`,
      `"status" = 'REDEEMED' AND "redeemedAt" IS NOT NULL AND "redeemedJourneyId" IS NOT NULL AND "revokedAt" IS NULL`,
      `"status" = 'REVOKED' AND "revokedAt" IS NOT NULL AND "redeemedAt" IS NULL AND "redeemedJourneyId" IS NULL`,
    ]) {
      expect(flat).toContain(clause);
    }
    // One credential can only ever open one journey.
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "StoreEntryToken_redeemedJourneyId_key" ON "StoreEntryToken"("redeemedJourneyId")',
    );
  });

  it('makes a replayed projection impossible and its audit trail honest', () => {
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "StoreFlowProjection_tenantId_journeyEventId_key" ON "StoreFlowProjection"("tenantId", "journeyEventId")',
    );
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "StoreFlowProjection_visionEventId_key" ON "StoreFlowProjection"("visionEventId")',
    );
    expect(flat).toContain(
      `ADD CONSTRAINT "StoreFlowProjection_outcome_evidence" CHECK ( ( "outcome" IN ('PROPOSED', 'AUTO_APPLIED', 'REJECTED') AND "visionEventId" IS NOT NULL )`,
    );
  });

  it('bounds the autonomy threshold and every recorded score to [0, 1]', () => {
    expect(flat).toContain(
      `ADD CONSTRAINT "StoreFlowPolicyVersion_confidence_in_range" CHECK ("autoApplyMinConfidence" >= 0 AND "autoApplyMinConfidence" <= 1)`,
    );
    expect(flat).toContain(
      `ADD CONSTRAINT "StoreFlowPolicyVersion_version_number_positive" CHECK ("versionNumber" >= 1)`,
    );
    expect(flat).toContain('"StoreFlowProjection_confidence_in_range"');
  });

  it('never lets a settled journey lose the order it became', () => {
    expect(flat).toContain(
      `ADD CONSTRAINT "CustomerJourney_settlement_evidence" CHECK ( "settlementStatus" NOT IN ('ORDER_CREATED', 'PAID') OR "orderId" IS NOT NULL )`,
    );
  });
});

describe('store flow module backfill migration', () => {
  const sql = readFileSync(
    join(
      __dirname,
      '..',
      '..',
      'prisma',
      'migrations',
      '20260916100001_store_flow_module_backfill',
      'migration.sql',
    ),
    'utf8',
  );

  it('activates a pre-existing store-flow module row instead of leaving it inactive', () => {
    expect(sql).toContain('ON CONFLICT ("code") DO UPDATE SET');
    expect(sql).toContain('"isActive" = true');
    expect(sql).not.toMatch(/DO UPDATE SET[^;]*"id"\s*=/);
  });

  it('is idempotent and never overwrites a tenant admin choice', () => {
    expect(sql).toContain('ON CONFLICT ("tenantId", "moduleId") DO NOTHING');
    expect(sql).not.toMatch(/ON CONFLICT \("tenantId", "moduleId"\) DO UPDATE/);
  });

  it('enables store-flow for every pre-existing tenant with deterministic ids', () => {
    expect(sql).toContain(`'tm-' || md5(t."id" || ':store-flow')`);
    expect(sql).toContain(`WHERE pm."code" = 'store-flow'`);
  });

  it('grants no autonomy on its own', () => {
    // The backfill must not publish a policy: a store keeps observing until
    // an operator opts it in, which is the whole safety story of the phase.
    expect(sql).not.toContain('StoreFlowPolicy');
    expect(sql).not.toContain('AUTO_APPLY');
    expect(sql).not.toContain('PROPOSE');
  });
});

describe('returns & reconciliation migration hardening', () => {
  const migrationsDir = join(__dirname, '..', '..', 'prisma', 'migrations');
  const sql = readFileSync(
    join(
      migrationsDir,
      '20260916110000_phase27_returns_reconciliation',
      'migration.sql',
    ),
    'utf8',
  );
  // The hand-written statements are wrapped across lines for readability;
  // compare against a whitespace-normalized copy so formatting is never
  // load-bearing.
  const flat = sql.replace(/\s+/g, ' ');

  it('adds the two reverse-flow ledger movement types', () => {
    // A return, a cancellation reversal and a shrink are ORDINARY movements —
    // the enum is extended rather than a parallel stock table invented.
    expect(sql).toContain(
      `ALTER TYPE "InventoryMovementType" ADD VALUE 'RETURN_IN'`,
    );
    expect(sql).toContain(
      `ALTER TYPE "InventoryMovementType" ADD VALUE 'SHRINK'`,
    );
  });

  it('makes a restocked return line impossible without its ledger movement', () => {
    // THE stock invariant, at the database level: there is no way to record
    // goods going back on the shelf without the append-only movement that put
    // them there.
    expect(flat).toContain(
      `ADD CONSTRAINT "OrderReturnLine_restock_has_movement" CHECK ("restocked" = false OR "movementId" IS NOT NULL)`,
    );
    expect(flat).toContain(
      `ADD CONSTRAINT "OrderReturnLine_quantity_positive" CHECK ("quantity" > 0)`,
    );
  });

  it('makes a cycle count incapable of becoming a second source of truth', () => {
    // The variance must be DERIVED from the counted figure and the projection
    // (never an arbitrary number), and a non-zero variance must cite the
    // movement it became. Together: a count can only change stock by
    // appending to the ledger.
    expect(flat).toContain(
      `ADD CONSTRAINT "CycleCountLine_variance_is_derived" CHECK ( "varianceQuantity" IS NULL OR "systemQuantity" IS NULL OR "varianceQuantity" = "countedQuantity" - "systemQuantity" )`,
    );
    expect(flat).toContain(
      `ADD CONSTRAINT "CycleCountLine_variance_has_movement" CHECK ( "varianceQuantity" IS NULL OR "varianceQuantity" = 0 OR "movementId" IS NOT NULL )`,
    );
    expect(flat).toContain(
      `ADD CONSTRAINT "CycleCountLine_counted_quantity_nonnegative" CHECK ("countedQuantity" >= 0)`,
    );
  });

  it('never lets a count claim a status its evidence does not support', () => {
    expect(flat).toContain('"CycleCount_status_evidence"');
    for (const clause of [
      `"status" = 'OPEN' AND "reconciledAt" IS NULL AND "cancelledAt" IS NULL`,
      `"status" = 'RECONCILED' AND "reconciledAt" IS NOT NULL AND "cancelledAt" IS NULL`,
      `"status" = 'CANCELLED' AND "cancelledAt" IS NOT NULL AND "reconciledAt" IS NULL`,
    ]) {
      expect(flat).toContain(clause);
    }
  });

  it('bounds every refund by what was actually captured', () => {
    // THE money invariant, at the database level: an intent can never report
    // more refunded than it captured, and no refund is for nothing.
    expect(flat).toContain(
      `ADD CONSTRAINT "PaymentIntent_refund_within_capture" CHECK ("refundedAmountMinor" >= 0 AND "refundedAmountMinor" <= "capturedAmountMinor")`,
    );
    expect(flat).toContain(
      `ADD CONSTRAINT "PaymentRefund_amount_positive" CHECK ("amountMinor" > 0)`,
    );
  });

  it('makes a replayed refund impossible at the database level', () => {
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "PaymentRefund_tenantId_idempotencyKey_key" ON "PaymentRefund"("tenantId", "idempotencyKey")',
    );
    expect(flat).toContain(
      `ADD CONSTRAINT "PaymentRefund_settlement_evidence" CHECK ( ("status" = 'PENDING' AND "settledAt" IS NULL) OR ("status" IN ('SUCCEEDED', 'FAILED') AND "settledAt" IS NOT NULL) )`,
    );
  });

  it('makes a replayed return and a replayed write-off impossible too', () => {
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "OrderReturn_tenantId_reference_key" ON "OrderReturn"("tenantId", "reference")',
    );
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "CycleCount_tenantId_reference_key" ON "CycleCount"("tenantId", "reference")',
    );
    // One observation can be written off exactly once.
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "ShrinkEvent_visionEventId_key" ON "ShrinkEvent"("visionEventId")',
    );
  });

  it('keeps a return status and its money together', () => {
    expect(flat).toContain(
      `ADD CONSTRAINT "OrderReturn_refund_evidence" CHECK ( ("status" = 'RECORDED' AND "refundId" IS NULL) OR ("status" <> 'RECORDED' AND "refundId" IS NOT NULL) )`,
    );
  });

  it('requires a CV-detected write-off to name the observation behind it', () => {
    expect(flat).toContain(
      `ADD CONSTRAINT "ShrinkEvent_cv_detected_has_observation" CHECK ("source" <> 'CV_DETECTED' OR "visionEventId" IS NOT NULL)`,
    );
    expect(flat).toContain(
      `ADD CONSTRAINT "ShrinkEvent_quantity_positive" CHECK ("quantity" > 0)`,
    );
    // movementId is NOT NULL on the table itself: a shrink record can never
    // exist without the ledger entry it claims to have produced.
    expect(flat).toContain('"movementId" TEXT NOT NULL');
  });

  it('enforces same-tenant references with composite foreign keys', () => {
    for (const [constraint, columns, parent] of [
      ['PaymentRefund_intent_same_tenant_fkey', '"intentId", "tenantId"', 'PaymentIntent'],
      ['PaymentRefund_capture_same_tenant_fkey', '"captureId", "tenantId"', 'PaymentCapture'],
      ['OrderReturn_order_same_tenant_fkey', '"orderId", "tenantId"', 'Order'],
      ['OrderReturn_refund_same_tenant_fkey', '"refundId", "tenantId"', 'PaymentRefund'],
      ['OrderReturnLine_return_same_tenant_fkey', '"returnId", "tenantId"', 'OrderReturn'],
      ['OrderReturnLine_order_line_same_tenant_fkey', '"orderLineId", "tenantId"', 'OrderLine'],
      ['OrderReturnLine_product_same_tenant_fkey', '"productId", "tenantId"', 'Product'],
      ['OrderReturnLine_movement_same_tenant_fkey', '"movementId", "tenantId"', 'InventoryMovement'],
      ['CycleCount_location_same_tenant_fkey', '"locationId", "tenantId"', 'Location'],
      ['CycleCountLine_count_same_tenant_fkey', '"cycleCountId", "tenantId"', 'CycleCount'],
      ['CycleCountLine_product_same_tenant_fkey', '"productId", "tenantId"', 'Product'],
      ['CycleCountLine_movement_same_tenant_fkey', '"movementId", "tenantId"', 'InventoryMovement'],
      ['ShrinkEvent_location_same_tenant_fkey', '"locationId", "tenantId"', 'Location'],
      ['ShrinkEvent_product_same_tenant_fkey', '"productId", "tenantId"', 'Product'],
      ['ShrinkEvent_vision_event_same_tenant_fkey', '"visionEventId", "tenantId"', 'VisionEvent'],
      ['ShrinkEvent_movement_same_tenant_fkey', '"movementId", "tenantId"', 'InventoryMovement'],
    ] as const) {
      expect(flat).toContain(
        `ADD CONSTRAINT "${constraint}" FOREIGN KEY (${columns}) REFERENCES "${parent}"("id", "tenantId")`,
      );
    }
  });

  it('anchors the ledger composite FK with a (id, tenantId) unique index', () => {
    // Without this, a decision record could cite another tenant's movement.
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "InventoryMovement_id_tenantId_key" ON "InventoryMovement"("id", "tenantId")',
    );
  });

  it('never covers User references with composite FKs (platform-sandbox exception)', () => {
    // A platform admin acting in the sandbox tenant is a (platform user,
    // sandbox tenant) pair that User(id, tenantId) can never hold.
    expect(flat).not.toMatch(
      /same_tenant_fkey" FOREIGN KEY \("(createdById|recordedById|reconciledById)"/,
    );
  });

  it('creates exactly the columns schema.prisma declares, for every new table', () => {
    // This repo hand-writes migration SQL, so nothing else catches a column
    // that exists in the Prisma model and not in the database. `\r?\n`
    // throughout: the repo is checked out with core.autocrlf on Windows.
    const schema = readFileSync(
      join(__dirname, '..', '..', 'prisma', 'schema.prisma'),
      'utf8',
    );
    const schemaColumns = (model: string): string[] => {
      const body = schema.match(
        new RegExp(
          `\\r?\\nmodel ${model} \\{\\r?\\n([\\s\\S]*?)\\r?\\n\\}`,
        ),
      );
      expect(body).not.toBeNull();
      return body![1]
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(
          (line) =>
            line.length > 0 &&
            !line.startsWith('//') &&
            !line.startsWith('///') &&
            !line.startsWith('@@') &&
            !/^\w+\s+\w+(\[\])?\??\s+@relation/.test(line) &&
            !/^\w+\s+\w+\[\]/.test(line),
        )
        .map((line) => line.split(/\s+/)[0])
        .filter((name) => /^[a-z]/.test(name));
    };
    const migrationColumns = (table: string): string[] => {
      const body = sql.match(
        new RegExp(
          `CREATE TABLE "${table}" \\(\\r?\\n([\\s\\S]*?)\\r?\\n\\);`,
        ),
      );
      expect(body).not.toBeNull();
      return [...body![1].matchAll(/^ {4}"([A-Za-z0-9_]+)"/gm)].map(
        (match) => match[1],
      );
    };
    for (const model of [
      'PaymentRefund',
      'OrderReturn',
      'OrderReturnLine',
      'CycleCount',
      'CycleCountLine',
      'ShrinkEvent',
    ]) {
      expect([model, migrationColumns(model).sort()]).toEqual([
        model,
        schemaColumns(model).sort(),
      ]);
    }
  });

  it('never cascades deletes into the reverse-flow tables', () => {
    // A return, a count and a write-off are financial/stock history: removing
    // a parent must FAIL, never silently erase the record of what happened.
    expect(sql).not.toMatch(/ON DELETE (CASCADE|SET NULL)/);
  });
});

describe('returns module backfill migration', () => {
  const sql = readFileSync(
    join(
      __dirname,
      '..',
      '..',
      'prisma',
      'migrations',
      '20260916110001_returns_module_backfill',
      'migration.sql',
    ),
    'utf8',
  );

  it('activates a pre-existing returns module row instead of leaving it inactive', () => {
    expect(sql).toContain('ON CONFLICT ("code") DO UPDATE SET');
    expect(sql).toContain('"isActive" = true');
    expect(sql).not.toMatch(/DO UPDATE SET[^;]*"id"\s*=/);
  });

  it('is idempotent and never overwrites a tenant admin choice', () => {
    expect(sql).toContain('ON CONFLICT ("tenantId", "moduleId") DO NOTHING');
    expect(sql).not.toMatch(/ON CONFLICT \("tenantId", "moduleId"\) DO UPDATE/);
  });

  it('enables returns for every pre-existing tenant with deterministic ids', () => {
    expect(sql).toContain(`'tm-' || md5(t."id" || ':returns')`);
    expect(sql).toContain(`WHERE pm."code" = 'returns'`);
  });

  it('moves no stock and no money on its own', () => {
    // A backfill enables routes. It must never write a movement, a refund or
    // a return — the reverse flow only ever runs when an operator asks.
    for (const table of [
      'InventoryMovement',
      'InventoryLevel',
      'PaymentRefund',
      'OrderReturn',
      'CycleCount',
      'ShrinkEvent',
    ]) {
      expect(sql).not.toContain(table);
    }
  });
});
