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
