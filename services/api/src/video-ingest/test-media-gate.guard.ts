import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { VideoFrameExtractorPort } from './extraction/video-frame-extractor.port';
import { FrameTextRecognizerPort } from './recognition/frame-text-recognizer.port';

/**
 * The controlled test-media 503, WORD FOR WORD as `VideoAssetsService.upload`
 * raises it. The gate now runs in TWO places and must be indistinguishable
 * from the outside: this guard refuses BEFORE the multipart body is read,
 * and the service keeps its own identical check as defense in depth for any
 * non-HTTP caller. Exported so the service can eventually IMPORT this
 * constant instead of holding a second copy of the string (the service is
 * owned by another agent in this cycle and was deliberately left untouched).
 */
export const TEST_MEDIA_GATE_CLOSED_MESSAGE =
  'Uploads are disabled: Phase 10 accepts CONTROLLED INTERNAL TEST ' +
  'MEDIA ONLY, under an explicit policy gate that is not enabled ' +
  'on this deployment. Enable it by setting ' +
  'VIDEO_TEST_MEDIA_INGEST_ENABLED=true with NODE_ENV explicitly ' +
  'development or test (it is refused at startup anywhere else). ' +
  'That gate is what authorizes storing a clip — text/OCR ' +
  'screening only ever rejects one, so nothing else can open this';

/**
 * The screening-tooling 503, WORD FOR WORD as `VideoAssetsService.upload`
 * raises it — same duplication note as above: exported so the service can
 * import it later rather than keep a divergent copy.
 */
export const SCREENING_TOOLING_UNAVAILABLE_MESSAGE =
  'Uploads are refused: pre-storage frame screening cannot run ' +
  'because the configured extractor and/or frame-text recognizer ' +
  'do not read the real media — configure VIDEO_FFMPEG_ENABLED=true ' +
  'and VIDEO_OCR_ENABLED=true (uploads are never stored unscreened ' +
  'in any environment)';

/**
 * The four REQUIRED operator attestations, carried as REQUEST HEADERS so
 * they can be enforced BEFORE the multipart body is parsed.
 *
 * WHY HEADERS AND NOT THE BODY FIELDS: the equivalent multipart fields
 * (`controlledTestMedia`, …) only exist AFTER multer has consumed — and
 * fully buffered in memory — the whole upload, which is exactly what this
 * gate must prevent. Headers arrive with the request line, so a guard can
 * read them without touching a single body byte. The BODY FIELDS REMAIN
 * REQUIRED and unchanged: they are the audited record the service persists
 * (and its post-parse re-check is defense in depth), while these headers
 * are the pre-buffer gate.
 *
 * Header naming follows the codebase's existing lowercase `x-…` convention
 * (`x-request-id`); each entry is paired with the multipart field it
 * mirrors so a rejection can name both halves of the contract.
 */
export const UPLOAD_ATTESTATION_HEADERS = [
  { header: 'x-controlled-test-media', field: 'controlledTestMedia' },
  { header: 'x-no-payment-cards-visible', field: 'noPaymentCardsVisible' },
  { header: 'x-no-customer-pii', field: 'noCustomerPII' },
  {
    header: 'x-attest-no-sensitive-content',
    field: 'attestNoSensitiveContent',
  },
] as const;

/** Comma-joined header list, for the rejection message. */
const ATTESTATION_HEADER_LIST = UPLOAD_ATTESTATION_HEADERS.map(
  ({ header }) => header,
).join(', ');

/**
 * The controlled 400 for a missing/invalid attestation header. It NAMES the
 * offending header and keeps the honest framing used everywhere else in
 * this module: these are DECLARATIONS the operator makes about media they
 * staged and control — nothing here (or anywhere in the ingest path)
 * inspects the frames to confirm them.
 */
export function attestationHeaderRejectionMessage(
  header: string,
  field: string,
): string {
  return (
    `${header} must be "true": Phase 10 accepts controlled internal test ` +
    'media only, and the four operator attestations are required as ' +
    `REQUEST HEADERS (${ATTESTATION_HEADER_LIST}) so they can be checked ` +
    'BEFORE the upload body is read — a missing or otherwise-valued ' +
    'header refuses the request before any byte is buffered. They are ' +
    'DECLARATIONS by the uploading operator about media they control, not ' +
    'findings about the content: nothing in this flow inspects the frames ' +
    `to confirm them. The matching multipart field (${field}) is still ` +
    'required as the audited record'
  );
}

/**
 * Normalization for an attestation header value: trimmed and lowercased,
 * then compared against the literal `true` — the same "strictly true,
 * anything else keeps the gate shut" idiom the policy flag and the DTO use,
 * with the whitespace/case tolerance a header value needs (proxies and HTTP
 * clients routinely re-case and pad header values). A repeated header
 * arrives as an array and is REJECTED rather than merged: an ambiguous
 * declaration is not a declaration.
 */
function isAffirmedHeader(value: string | string[] | undefined): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === 'true';
}

/**
 * THE PRE-BUFFER UPLOAD GATE.
 *
 * Nest's request lifecycle runs GUARDS BEFORE INTERCEPTORS: in
 * `@nestjs/core`'s `RouterExecutionContext.create`, the returned handler
 * awaits `fnCanActivate([req, res, next])` and only then calls
 * `interceptorsConsumer.intercept(...)`. `FileInterceptor` (multer) is an
 * INTERCEPTOR, so a guard that throws here rejects the request while the
 * multipart body is still unread on the socket — nothing has been buffered
 * into process memory.
 *
 * That ordering is what makes the documented "refused before any byte"
 * behaviour true. The identical checks inside `VideoAssetsService.upload`
 * used to be the ONLY ones, and they run after multer has already retained
 * the entire file: an authorized caller could push up to the upload limit
 * into memory with the deployment gate closed, the screening toolchain
 * absent, or no attestations at all. The service checks stay — as defense
 * in depth for any future non-HTTP ingest path and as the audited record —
 * but this guard is what enforces them first.
 *
 * The guard reads REQUEST HEADERS ONLY. It never touches `request.body`,
 * `request.file`, or the underlying stream (there is nothing parsed to
 * touch yet), so it cannot itself cause the buffering it exists to prevent.
 *
 * Applied to the upload route ONLY. Route-level guards run after the
 * globally registered auth/permission guards, so `video-asset:manage` is
 * still enforced ahead of this one — an unauthenticated or unauthorized
 * caller never learns anything about the deployment's gate configuration.
 */
@Injectable()
export class TestMediaGateGuard implements CanActivate {
  /**
   * TRUE only when the CONTROLLED TEST-MEDIA POLICY GATE is open — the
   * same two-part, fail-closed condition `VideoAssetsService` computes:
   * the explicit opt-in (VIDEO_TEST_MEDIA_INGEST_ENABLED, strictly the
   * literal "true") AND an explicitly non-production runtime (NODE_ENV
   * exactly 'development' or 'test'). Startup validation already refuses
   * the flag elsewhere; re-deriving it here keeps the gate local and
   * fail-closed on anything unexpected.
   */
  private readonly testMediaIngestGateOpen: boolean;

  constructor(
    config: ConfigService,
    private readonly extractor: VideoFrameExtractorPort,
    private readonly recognizer: FrameTextRecognizerPort,
  ) {
    const nodeEnv = config.get<string>('NODE_ENV');
    this.testMediaIngestGateOpen =
      config.get<string>('VIDEO_TEST_MEDIA_INGEST_ENABLED') === 'true' &&
      (nodeEnv === 'development' || nodeEnv === 'test');
  }

  canActivate(context: ExecutionContext): boolean {
    // 1. THE DEPLOYMENT GATE. With it shut the endpoint accepts nothing at
    //    all — and now refuses without the body ever being read.
    if (!this.testMediaIngestGateOpen) {
      throw new ServiceUnavailableException(TEST_MEDIA_GATE_CLOSED_MESSAGE);
    }
    // 2. THE SCREENING TOOLCHAIN. The pre-storage frame screen is the
    //    upload's rejection layer; when the extractor does not read real
    //    bytes or the recognizer does not read real pixels it cannot run,
    //    and an upload that cannot be screened is refused — again before
    //    the bytes are taken in.
    if (!this.extractor.readsRealBytes || !this.recognizer.readsRealPixels) {
      throw new ServiceUnavailableException(
        SCREENING_TOOLING_UNAVAILABLE_MESSAGE,
      );
    }
    // 3. THE OPERATOR ATTESTATIONS, from headers only — the multipart
    //    fields do not exist yet, and waiting for them is precisely the
    //    bug this guard closes.
    const { headers } = context.switchToHttp().getRequest<Request>();
    for (const { header, field } of UPLOAD_ATTESTATION_HEADERS) {
      if (!isAffirmedHeader(headers[header])) {
        throw new BadRequestException(
          attestationHeaderRejectionMessage(header, field),
        );
      }
    }
    return true;
  }
}
