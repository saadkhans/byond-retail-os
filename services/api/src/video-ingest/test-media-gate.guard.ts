import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { isEnvFlagEnabled } from '../config/env.validation';
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
 * The screening-tooling READINESS 503 — a SEPARATE condition from the one
 * above, and deliberately a separate message.
 *
 * WHY NOT REUSE `SCREENING_TOOLING_UNAVAILABLE_MESSAGE`: that message's
 * remediation is "set VIDEO_FFMPEG_ENABLED=true and VIDEO_OCR_ENABLED=true".
 * This condition only ever fires when those flags are ALREADY true — the
 * real adapters were selected, they simply cannot run right now (the
 * toolchain is absent, not executable, or otherwise unusable on this host).
 * Serving the flag message here would send the operator to re-set flags they
 * already set and hide the actual fault; the two failures have genuinely
 * different fixes, so they get different words.
 *
 * WHAT IT DELIBERATELY DOES NOT SAY: nothing about the host. No paths, no
 * binary names or locations, no argv, no errno/signal/stderr. The readiness
 * probe itself returns a BARE BOOLEAN for exactly this reason — there is no
 * host detail available here to leak even by accident. The disclosure
 * delta versus the flag message is nil in any case: both say only "the
 * screening toolchain cannot run on this deployment", and both are reachable
 * ONLY by a caller who already passed the global auth guard and holds
 * `video-asset:manage` on a deployment that has explicitly opted into
 * test-media ingestion.
 */
export const SCREENING_TOOLING_NOT_READY_MESSAGE =
  'Uploads are refused: pre-storage frame screening is configured to use ' +
  'real media tooling, but that tooling cannot currently run on this ' +
  'deployment, so the screen cannot happen and nothing is stored (uploads ' +
  'are never stored unscreened in any environment). This is a deployment ' +
  'condition rather than a problem with the request — retry once the ' +
  'screening toolchain is operational';

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
 * WHAT IT COVERS — all four layers, and every one of them BEFORE A SINGLE
 * BYTE OF THE BODY IS READ:
 *   1. DEPLOYMENT POLICY — the controlled test-media opt-in plus an
 *      explicitly non-production NODE_ENV.
 *   2. CAPABILITY FLAGS — the configured adapters claim to read the real
 *      media (`readsRealBytes` / `readsRealPixels`); this is what rejects
 *      the simulated adapters, whose "no text found" would be a blind pass.
 *   3. ACTUAL TOOLING READINESS — the claimed toolchain can genuinely RUN
 *      here (`checkToolingReady()` on both ports). A flag that enables the
 *      real decode/OCR adapters is a statement of INTENT; with the
 *      underlying tooling missing or non-executable the capability flags
 *      still read true — the adapter was selected, it just cannot run. Before
 *      this layer existed the guard passed, multer buffered the entire
 *      upload, and the failure only surfaced after parsing — defeating the
 *      point of a pre-buffer gate.
 *   4. OPERATOR ATTESTATIONS — the four declaration headers.
 *
 * Nest's request lifecycle runs GUARDS BEFORE INTERCEPTORS: in
 * `@nestjs/core`'s `RouterExecutionContext.create`, the returned handler
 * awaits `fnCanActivate([req, res, next])` and only then calls
 * `interceptorsConsumer.intercept(...)`. `FileInterceptor` (multer) is an
 * INTERCEPTOR, so a guard that throws here rejects the request while the
 * multipart body is still unread on the socket — nothing has been buffered
 * into process memory. That `await` is also why this guard may be ASYNC
 * (layer 3 is a promise) without weakening the guarantee: Nest waits for the
 * guard to settle before it constructs the interceptor chain, so multer has
 * still not looked at the socket while the readiness probe is in flight.
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
 * COST: the checks are ordered cheapest-first and short-circuit, so a
 * request that fails layer 1 or 2 never probes readiness at all, and a
 * request that reaches layer 3 costs at most ONE awaited call per port.
 * The probes are memoized behind a short TTL INSIDE the adapters — this
 * guard deliberately keeps no cache of its own, so there is exactly one
 * definition of "recently checked" in the process.
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
   * the explicit opt-in (VIDEO_TEST_MEDIA_INGEST_ENABLED) AND an explicitly
   * non-production runtime (NODE_ENV exactly 'development' or 'test').
   * Startup validation already refuses the flag elsewhere; re-deriving it
   * here keeps the gate local and fail-closed on anything unexpected.
   *
   * THE FLAG IS READ THROUGH `isEnvFlagEnabled` — the codebase's ONE
   * definition of an enabled boolean env var (trim + case-fold), shared with
   * startup validation, the video-ingest module's adapter factories, and
   * `VideoAssetsService`'s copy of this gate. The former local `=== 'true'`
   * compare disagreed with all three: a deployment configured
   * `VIDEO_TEST_MEDIA_INGEST_ENABLED=TRUE` passes boot validation, selects
   * the real tooling, and passes the service gate, yet this guard shut and
   * 503'd every upload before multer ever ran. NODE_ENV is intentionally
   * still an EXACT match — it is a validated enum, not a boolean flag, so
   * the boolean helper does not apply to it and 'TEST'/'Development' keep
   * the gate closed.
   */
  private readonly testMediaIngestGateOpen: boolean;

  constructor(
    config: ConfigService,
    private readonly extractor: VideoFrameExtractorPort,
    private readonly recognizer: FrameTextRecognizerPort,
  ) {
    const nodeEnv = config.get<string>('NODE_ENV');
    this.testMediaIngestGateOpen =
      isEnvFlagEnabled(config.get<string>('VIDEO_TEST_MEDIA_INGEST_ENABLED')) &&
      (nodeEnv === 'development' || nodeEnv === 'test');
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
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
    // 3. THE TOOLING ITSELF. The flags above are a statement of INTENT —
    //    "the real adapters are selected". They stay true when the
    //    underlying decode/OCR tooling is missing or not executable, in
    //    which case the
    //    screen still cannot run and the upload must be refused BEFORE the
    //    body is taken in; without this the guard passed, multer buffered
    //    the whole file, and the failure only surfaced after parsing.
    //    Ordered AFTER the flag checks so the cheap in-memory conditions
    //    fail fast and this is never probed for a request the deployment
    //    gate already refuses. Each probe is one awaited call, memoized
    //    with a short TTL inside the adapter (no second cache here), never
    //    throws, and yields a bare boolean — there is no host detail in
    //    hand to leak into the response.
    if (
      !(await this.extractor.checkToolingReady()) ||
      !(await this.recognizer.checkToolingReady())
    ) {
      throw new ServiceUnavailableException(SCREENING_TOOLING_NOT_READY_MESSAGE);
    }
    // 4. THE OPERATOR ATTESTATIONS, from headers only — the multipart
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
