import { isIP } from 'node:net';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CameraSource,
  CameraSourceStatus,
  CameraSourceType,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { containsSensitiveFreeText } from '../video-ingest/media-safety';
import {
  CAMERA_CREDENTIAL_SLOTS,
  CreateCameraSourceDto,
} from './dto/create-camera-source.dto';
import { UpdateCameraSourceDto } from './dto/update-camera-source.dto';

/**
 * Phase 12 — camera source registry (SHADOW pilot).
 *
 * A CameraSource names where footage comes from. Only FILE_REPLAY is
 * functional in this MVP; RTSP / webcam types register as DISABLED
 * placeholders and cannot be activated. SECRETS NEVER TOUCH THIS TABLE:
 * connectionNote is screened free text (a credential-embedding stream URL
 * is rejected on write) and credentialRef is the NAME of an
 * operator-managed secret slot. Responses expose only whether a
 * credential slot is configured — never the reference itself, never a
 * URL.
 */

export const PLACEHOLDER_SOURCE_TYPES: readonly CameraSourceType[] = [
  CameraSourceType.RTSP_PLACEHOLDER,
  CameraSourceType.LOCAL_WEBCAM_PLACEHOLDER,
];

export const SOURCE_TYPE_NOT_ENABLED =
  'source type not enabled in shadow pilot';

// The allowlist itself lives in create-camera-source.dto.ts (single
// definition, mirrored by the DB CHECK) and is re-exported here for the
// specs and any server-side caller.
export { CAMERA_CREDENTIAL_SLOTS } from './dto/create-camera-source.dto';

const CREDENTIAL_REF_REJECTED =
  'credentialRef must be one of the server-recognized credential slots ' +
  `(${CAMERA_CREDENTIAL_SLOTS.join(', ')}) — never a password, card ` +
  'number, key, token, URL, or connection string';

/** Pure credentialRef validator — null = a server-recognized slot, else
 *  the controlled rejection message listing the allowed slots. The
 *  allowlist replaces every shape heuristic (Codex P1): caller-composed
 *  suffixes could smuggle letter-separated card numbers or password
 *  words past any pattern, so only server-issued names are trusted. */
export function validateCredentialRef(value: string): string | null {
  return (CAMERA_CREDENTIAL_SLOTS as readonly string[]).includes(value)
    ? null
    : CREDENTIAL_REF_REJECTED;
}

// ---------------------------------------------------------------------
// connectionNote validation — FREE TEXT for humans, never an address.
//
// The note is rejected when ANY of the named checks below smells machine
// connection data, INDEPENDENT of whether credentials are embedded (a
// credential-free internal stream address is still a source URL). The
// checks are layered so no single fragile pattern is load-bearing:
//   A. explicit URI schemes (scheme://…, generic — covers rtsp, http,
//      mqtt, redis, and every other scheme),
//   B. scheme-colon endpoint forms (rtsp:cam3) for known schemes,
//   C. connection-string key=value pairs (host=…, password=…),
//   D. dotted hostnames and IPv4 addresses,
//   E. scheme-relative URLs (//host/…) ANYWHERE — start, after
//      whitespace, or after any punctuation/separator,
//   F. IPv6 literals and endpoints judged by Node's OWN address parser
//      (net.isIP) over tokenized candidates AND bracket contents —
//      never a shape heuristic that an all-numeric full-form address
//      could slip past.
// ---------------------------------------------------------------------

/** A. Any explicit URI scheme. */
const URI_SCHEME = /[a-z][a-z0-9+.-]*:\/\//i;
/** B. Scheme-colon endpoint form for known schemes (rtsp:cam3). */
const SCHEME_COLON =
  /\b(rtsp|rtsps|rtmp|http|https|ws|wss|mqtt|tcp|udp|file|ftp|sftp|ssh|srt|postgres|postgresql|mysql|redis)\s*:/i;
/** C. Connection-string key=value pairs. */
const CONNECTION_KEY_VALUE =
  /\b(host|hostname|user|username|password|port|dbname|database)\s*=/i;
/** D1. Dotted hostname: first label starts with a LETTER and the final
 *  label is alphabetic (camera.internal, cam-3.store.local) —
 *  measurements like "2.5m" or "aisle 3.5" start with digits and pass. */
const DOTTED_HOSTNAME = /\b(?=[a-z])[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}\b/i;
/** D2. IPv4 address. */
const IPV4_ADDRESS = /\b\d{1,3}(\.\d{1,3}){3}\b/;

/** E. Scheme-relative URL (//host/…): a source address with the scheme
 *  merely omitted. The rule is deliberately STRICTER than a boundary
 *  enumeration: "//" immediately followed by a non-space is never needed
 *  in a shelf note, so it is rejected wherever it appears — at the
 *  start, after whitespace, or butted against any punctuation or
 *  separator (endpoint=//…, endpoint=(//…), see [//…], value:{//…},
 *  note,'//…'). Enumerating boundary characters would leave the next
 *  unenumerated one open. */
const SCHEME_RELATIVE = /\/\/\S/;

/** F-supplement: bracketed address SHAPE ([hex:digits…], with or without
 *  :port). Kept alongside the parser-based check below so even a
 *  malformed-but-address-shaped bracketed endpoint is refused. */
const BRACKETED_IPV6 = /\[[0-9a-f:.]+\](:\d+)?/i;

/** Candidate runs for IPv6 extraction: maximal substrings of hex digits
 *  and colons, pulled straight from the RAW note. Delimiter-INDEPENDENT
 *  by construction (Codex P1): any character that is not hex or a colon
 *  — slash, hash, hyphen, '=', '@', whitespace, brackets, anything —
 *  simply terminates a run, so there is no separator allowlist whose
 *  next unenumerated character leaks an address through. */
const IPV6_CANDIDATE_RUN = /[0-9a-f:]{3,}/gi;

/** F. IPv6 literals and endpoints, PARSER-based and delimiter-
 *  INDEPENDENT (Codex P1): every candidate is judged by Node's own
 *  address parser (`isIP(...) === 6`) — the regex only EXTRACTS, it
 *  never decides validity, and no shape heuristic (hex letters, "::")
 *  is trusted. Candidates come from two extractions over the whole raw
 *  note, with no token-separator allowlist anywhere:
 *    1. the CONTENTS of every [bracketed] span — catches [addr],
 *       [addr]:554, and [addr]:554/live regardless of the attaching
 *       punctuation (endpoint-[addr]:554 included);
 *    2. every maximal hex-and-colon RUN in the note — a label or ANY
 *       punctuation (endpoint:…, endpoint/…, endpoint#…, endpoint-…,
 *       "camera at …", "….") terminates or precedes the run without
 *       being part of it. Each run is tested as-is, then at every
 *       colon-boundary suffix (a label's own trailing ':' glues onto
 *       the run — ":2001:0:…" must still surface "2001:0:…", never
 *       dropping the leading group), each variant also with trailing
 *       colons trimmed.
 *  Prose with ordinary colons stays valid free text because the parser
 *  rejects it: "12:30" → 0, "12:30:45" → 0, "note:" contributes no
 *  parsable run at all. */
function containsIpv6Endpoint(note: string): boolean {
  for (const bracketed of note.matchAll(/\[([^\]]*)\]/g)) {
    if (isIP(bracketed[1].split('%')[0]) === 6) {
      return true;
    }
  }
  for (const match of note.matchAll(IPV6_CANDIDATE_RUN)) {
    const run = match[0];
    if (!run.includes(':')) {
      continue;
    }
    // Suffix starts: position 0, then after each colon — so a leading
    // label colon is shed WITHOUT losing the first address group.
    let start = 0;
    for (;;) {
      const candidate = run.slice(start);
      if (isIP(candidate) === 6 || isIP(candidate.replace(/:+$/, '')) === 6) {
        return true;
      }
      const nextColon = run.indexOf(':', start);
      if (nextColon === -1) {
        break;
      }
      start = nextColon + 1;
    }
  }
  return false;
}

const CONNECTION_NOTE_REJECTED =
  'connectionNote is free text only — URLs, hostnames, addresses, and ' +
  'connection strings are never stored (configure sources through ' +
  'operator-managed slots)';

/** Pure connectionNote screen — null = safe free text, else the
 *  controlled rejection message. Every create/update path routes through
 *  screenNote → this helper; there is no second validation site. */
export function connectionNoteViolation(note: string): string | null {
  if (
    URI_SCHEME.test(note) ||
    SCHEME_COLON.test(note) ||
    CONNECTION_KEY_VALUE.test(note) ||
    DOTTED_HOSTNAME.test(note) ||
    IPV4_ADDRESS.test(note) ||
    SCHEME_RELATIVE.test(note) ||
    BRACKETED_IPV6.test(note) ||
    containsIpv6Endpoint(note)
  ) {
    return CONNECTION_NOTE_REJECTED;
  }
  return null;
}

export interface CameraSourceView {
  id: string;
  locationId: string;
  unitId: string | null;
  name: string;
  shelfZone: string | null;
  sourceType: CameraSourceType;
  status: CameraSourceStatus;
  connectionNote: string | null;
  /** REDACTION BOUNDARY: the reference name itself never leaves the API. */
  hasCredentialRef: boolean;
  replayVideoAssetId: string | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** The ONE response mapper — every read path routes through it so the
 *  credentialRef redaction cannot drift between endpoints. */
export function toCameraSourceView(source: CameraSource): CameraSourceView {
  return {
    id: source.id,
    locationId: source.locationId,
    unitId: source.unitId,
    name: source.name,
    shelfZone: source.shelfZone,
    sourceType: source.sourceType,
    status: source.status,
    connectionNote: source.connectionNote,
    hasCredentialRef: source.credentialRef !== null,
    replayVideoAssetId: source.replayVideoAssetId,
    lastError: source.lastError,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  };
}

@Injectable()
export class CameraSourcesService {
  constructor(private readonly prisma: PrismaService) {}

  private screenNote(note: string | undefined): string | null {
    if (note === undefined) {
      return null;
    }
    if (containsSensitiveFreeText(note)) {
      throw new BadRequestException(
        'connectionNote must not contain credential- or payment-bearing ' +
          'content (store secrets in an operator-managed slot and set ' +
          'credentialRef to its name)',
      );
    }
    // No-URL boundary: even a credential-FREE URL or hostname is machine
    // connection data, not a note.
    const violation = connectionNoteViolation(note);
    if (violation) {
      throw new BadRequestException(violation);
    }
    return note.slice(0, 500);
  }

  private screenCredentialRef(value: string): string {
    const rejection = validateCredentialRef(value);
    if (rejection) {
      throw new BadRequestException(rejection);
    }
    return value;
  }

  async create(
    tenantId: string,
    input: CreateCameraSourceDto,
    actorId?: string,
  ): Promise<CameraSourceView> {
    const location = await this.prisma.location.findFirst({
      where: { tenantId, id: input.locationId },
      select: { id: true },
    });
    if (!location) {
      throw new NotFoundException('Store not found in this tenant');
    }
    if (input.unitId) {
      const unit = await this.prisma.retailUnit.findFirst({
        where: { tenantId, id: input.unitId, locationId: input.locationId },
        select: { id: true },
      });
      if (!unit) {
        throw new NotFoundException('Unit not found in this store');
      }
    }
    if (input.replayVideoAssetId) {
      // TENANT ISOLATION for the replay pointer: the DB deliberately has
      // no composite FK here (its single-column FK is SET NULL), so the
      // asset must be resolved within this tenant before every write.
      const asset = await this.prisma.videoAsset.findFirst({
        where: { tenantId, id: input.replayVideoAssetId, deletedAt: null },
        select: { id: true },
      });
      if (!asset) {
        throw new NotFoundException('Video asset not found in this tenant');
      }
    }
    // Placeholders register DISABLED and stay that way (MVP: FILE_REPLAY
    // is the only runnable source).
    const status = PLACEHOLDER_SOURCE_TYPES.includes(input.sourceType)
      ? CameraSourceStatus.DISABLED
      : CameraSourceStatus.ACTIVE;
    try {
      const created = await this.prisma.cameraSource.create({
        data: {
          tenantId,
          locationId: input.locationId,
          unitId: input.unitId ?? null,
          name: input.name,
          shelfZone: input.shelfZone ?? null,
          sourceType: input.sourceType,
          status,
          connectionNote: this.screenNote(input.connectionNote),
          credentialRef:
            input.credentialRef !== undefined
              ? this.screenCredentialRef(input.credentialRef)
              : null,
          replayVideoAssetId: input.replayVideoAssetId ?? null,
          createdById: actorId ?? null,
        },
      });
      return toCameraSourceView(created);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          'a camera with this name already exists in this store',
        );
      }
      throw error;
    }
  }

  async list(tenantId: string): Promise<CameraSourceView[]> {
    const sources = await this.prisma.cameraSource.findMany({
      where: { tenantId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 100,
    });
    return sources.map(toCameraSourceView);
  }

  async byId(tenantId: string, id: string): Promise<CameraSourceView> {
    return toCameraSourceView(await this.requireSource(tenantId, id));
  }

  /** Tenant-scoped raw row for internal callers (replay runtime). */
  async requireSource(tenantId: string, id: string): Promise<CameraSource> {
    const source = await this.prisma.cameraSource.findFirst({
      where: { tenantId, id },
    });
    if (!source) {
      throw new NotFoundException('Camera source not found');
    }
    return source;
  }

  async update(
    tenantId: string,
    id: string,
    input: UpdateCameraSourceDto,
  ): Promise<CameraSourceView> {
    const source = await this.requireSource(tenantId, id);
    if (
      input.status === CameraSourceStatus.ACTIVE &&
      PLACEHOLDER_SOURCE_TYPES.includes(source.sourceType)
    ) {
      throw new ConflictException(SOURCE_TYPE_NOT_ENABLED);
    }
    if (input.replayVideoAssetId) {
      const asset = await this.prisma.videoAsset.findFirst({
        where: { tenantId, id: input.replayVideoAssetId, deletedAt: null },
        select: { id: true },
      });
      if (!asset) {
        throw new NotFoundException('Video asset not found in this tenant');
      }
    }
    const data: Prisma.CameraSourceUpdateInput = {};
    if (input.name !== undefined) {
      data.name = input.name;
    }
    if (input.shelfZone !== undefined) {
      data.shelfZone = input.shelfZone;
    }
    if (input.status !== undefined) {
      data.status = input.status;
    }
    if (input.connectionNote !== undefined) {
      data.connectionNote = this.screenNote(input.connectionNote);
    }
    if (input.credentialRef !== undefined) {
      data.credentialRef = this.screenCredentialRef(input.credentialRef);
    }
    if (input.replayVideoAssetId !== undefined) {
      data.replayVideoAsset = {
        connect: { id: input.replayVideoAssetId },
      };
    }
    // Tenant-scoped via the composite unique key — id alone must never
    // address another tenant's source.
    const updated = await this.prisma.cameraSource.update({
      where: { id_tenantId: { id, tenantId } },
      data,
    });
    return toCameraSourceView(updated);
  }
}
