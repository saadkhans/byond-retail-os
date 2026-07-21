import 'reflect-metadata';
import { EvidenceSourceType } from '@prisma/client';
import { REASON_CODE_PATTERN } from '../evidence-contract';
import {
  EvidenceBundleInputDto,
  IngestVisionEventDto,
} from './ingest-vision-event.dto';

/**
 * The PUBLISHED OpenAPI contract must match the Phase 7 evidence policy:
 * no artifact or metadata payload schemas exist at all, the inline
 * evidence bundle is a CLOSED lineage-only object, and no evidence field
 * publishes a loose/arbitrary object schema. These tests pin the Swagger
 * metadata the document is generated from.
 */
describe('IngestVisionEventDto OpenAPI schemas', () => {
  // Loose recursive view over the Swagger metadata tree — the tests only
  // read paths whose existence they assert.
  interface SchemaMeta {
    [key: string]: SchemaMeta;
  }

  const swaggerMeta = (
    target: object,
    property: string,
  ): SchemaMeta | undefined =>
    Reflect.getMetadata('swagger/apiModelProperties', target, property) as
      | SchemaMeta
      | undefined;

  it('publishes NO artifact or metadata properties anywhere', () => {
    for (const property of [
      'artifacts',
      'metadata',
      'sourceId',
      'modelName',
      'modelVersion',
      'notes',
    ]) {
      expect(
        swaggerMeta(EvidenceBundleInputDto.prototype, property),
      ).toBeUndefined();
    }
    for (const property of ['metadata', 'sourceId', 'modelName', 'modelVersion']) {
      expect(
        swaggerMeta(IngestVisionEventDto.prototype, property),
      ).toBeUndefined();
    }
  });

  describe('evidenceBundle (inline lineage record)', () => {
    const schema = swaggerMeta(
      IngestVisionEventDto.prototype,
      'evidenceBundle',
    ) as SchemaMeta;

    it('is published CLOSED (additionalProperties: false)', () => {
      expect(schema.additionalProperties).toBe(false);
    });

    it('publishes exactly the lineage fields', () => {
      expect(Object.keys(schema.properties).sort()).toEqual([
        'captureEndedAt',
        'captureStartedAt',
        'sourceType',
      ]);
    });

    it('publishes sourceType as the closed enum', () => {
      expect(schema.properties.sourceType.enum).toEqual(
        Object.values(EvidenceSourceType),
      );
    });
  });

  it('publishes reasonCodes as bounded lowercase slug strings', () => {
    const schema = swaggerMeta(
      IngestVisionEventDto.prototype,
      'reasonCodes',
    ) as SchemaMeta;
    expect(schema.items.pattern).toBe(REASON_CODE_PATTERN);
  });
});
