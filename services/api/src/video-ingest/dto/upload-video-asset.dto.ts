import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, Matches, MinLength } from 'class-validator';
import { IsOptionalNonNull } from '../../common/validation';

/**
 * Multipart companion fields for a test-video upload. The file itself
 * travels as the `file` part; these OPTIONAL ids bind the asset to a
 * store/unit/device/session, all verified same-tenant by composite FKs.
 * There is NO client-supplied storage path, filename override, or URL —
 * storage keys are server-generated.
 *
 * FOUR attestations are REQUIRED. They are the operator's DECLARATIONS
 * about media the operator controls, recorded in the audit trail as the
 * policy under which the clip was accepted. They are NOT a finding about
 * the content: nothing in the ingest path inspects the frames and
 * concludes they are free of card data. Storage is authorized by the
 * controlled test-media policy gate (VIDEO_TEST_MEDIA_INGEST_ENABLED,
 * non-production only) plus these declarations; the text/OCR screen that
 * runs before storage can only REJECT an upload — a quiet result from a
 * recognizer is an absence of detection, never evidence of absence.
 */
export class UploadVideoAssetDto {
  @ApiProperty({
    description:
      'REQUIRED operator attestation that this clip is CONTROLLED ' +
      'INTERNAL TEST MEDIA — staged footage the operator owns and can ' +
      'account for, never real customer footage and never third-party ' +
      'material. Phase 10 ingests nothing else. Must be the literal ' +
      'string "true".',
  })
  @IsString()
  @Matches(/^true$/, {
    message:
      'controlledTestMedia must be "true": Phase 10 ingests controlled ' +
      'internal test clips only — staged footage the operator owns, never ' +
      'real customer or third-party footage',
  })
  controlledTestMedia!: string;

  @ApiProperty({
    description:
      'REQUIRED operator attestation that no payment card is visible ' +
      'anywhere in the clip. A DECLARATION by the operator about media ' +
      'they staged — the API does not verify it, and the text/OCR screen ' +
      'can only reject a clip, never confirm one. Must be the literal ' +
      'string "true".',
  })
  @IsString()
  @Matches(/^true$/, {
    message:
      'noPaymentCardsVisible must be "true": uploads are accepted only ' +
      'with the operator\'s explicit declaration that no payment card is ' +
      'visible in the clip (a declaration, not a verification)',
  })
  noPaymentCardsVisible!: string;

  @ApiProperty({
    description:
      'REQUIRED operator attestation that the clip contains no customer ' +
      'personal data — no identifiable customers, no documents, no ' +
      'screens showing personal records. A DECLARATION by the operator, ' +
      'not something the API checks. Must be the literal string "true".',
  })
  @IsString()
  @Matches(/^true$/, {
    message:
      'noCustomerPII must be "true": uploads are accepted only with the ' +
      'operator\'s explicit declaration that the clip contains no ' +
      'customer personal data (a declaration, not a verification)',
  })
  noCustomerPII!: string;

  @ApiProperty({
    description:
      'REQUIRED operator attestation that the clip\'s frames contain no ' +
      'payment-card or credential content. Text screening cannot prove ' +
      'this — it inspects recognized text and can only REJECT what it ' +
      'DETECTS, and rotated, blurred, stylized, occluded or low-quality ' +
      'digits defeat recognition routinely — so the declaration is ' +
      'recorded as the operator\'s statement, alongside the controlled ' +
      'test-media policy gate that actually authorizes the ingest. Must ' +
      'be the literal string "true".',
  })
  @IsString()
  @Matches(/^true$/, {
    message:
      'attestNoSensitiveContent must be "true": uploads are accepted only ' +
      'with the operator\'s explicit declaration that the staged test ' +
      'clip carries no payment-card or credential content in its frames ' +
      '(a declaration, not a verification)',
  })
  attestNoSensitiveContent!: string;

  @ApiPropertyOptional({ description: 'Store (location) the clip was shot in.' })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  locationId?: string;

  @ApiPropertyOptional({ description: 'Retail unit in frame (must be in the store).' })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  unitId?: string;

  @ApiPropertyOptional({ description: 'Source camera/device (must be attached to the unit).' })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  deviceId?: string;

  @ApiPropertyOptional({ description: 'Checkout session the clip relates to.' })
  @IsOptionalNonNull()
  @IsString()
  @MinLength(1)
  sessionId?: string;
}
