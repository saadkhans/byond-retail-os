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
import { containsSensitiveValue } from '../common/sensitive-keys';
import { PrismaService } from '../prisma/prisma.service';
import { containsSensitiveFreeText } from '../video-ingest/media-safety';
import { CreateCameraSourceDto } from './dto/create-camera-source.dto';
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

/**
 * The ONLY credentialRef shape this API persists: a reserved slot name in
 * the CAMERA_SECRET_SLOT_* namespace (mirrored by a DB CHECK). The
 * namespace is the point — a password, PAN, API key, JWT, URL, or
 * connection string cannot ACCIDENTALLY be shaped like this, so an
 * operator pasting a real secret gets a controlled rejection instead of
 * a persisted credential.
 */
export const CREDENTIAL_SLOT_PATTERN = /^CAMERA_SECRET_SLOT_[A-Z0-9_]{3,40}$/;

const CREDENTIAL_REF_REJECTED =
  'credentialRef must name a reserved credential slot ' +
  '(CAMERA_SECRET_SLOT_<NAME>, A-Z/0-9/_ only) — never a password, card ' +
  'number, key, token, URL, or connection string';

/** Suffix words that would make a "slot name" a secret label in costume —
 *  an operator typing CAMERA_SECRET_SLOT_PASSWORD is about to paste the
 *  password itself somewhere; refuse the pattern early. */
const RESERVED_SUFFIX_WORDS = new Set([
  'PASSWORD',
  'PASSWD',
  'SECRET',
  'TOKEN',
  'APIKEY',
  'KEY',
  'JWT',
  'BEARER',
  'PAN',
  'CARD',
]);

/** Pure credentialRef validator — null = acceptable slot name, else the
 *  controlled rejection message. Belt AND braces: the strict namespace
 *  pattern first, then separator-normalized PAN detection, suffix shape
 *  rules, and the shared secret-value detector. */
export function validateCredentialRef(value: string): string | null {
  if (!CREDENTIAL_SLOT_PATTERN.test(value)) {
    return CREDENTIAL_REF_REJECTED;
  }
  // Separator-NORMALIZED digit check (Codex P1): a card number split by
  // the slot charset's own underscores (or pasted with spaces/dashes)
  // must be caught — strip separators first, then any card-length digit
  // run is out, whether or not it Luhn-validates.
  const normalized = value.replace(/[\s_-]/g, '');
  if (/\d{12,}/.test(normalized)) {
    return CREDENTIAL_REF_REJECTED;
  }
  const suffix = value.slice('CAMERA_SECRET_SLOT_'.length);
  // A mostly-numeric suffix is an account/card fragment wearing a slot
  // name, not a name — names are words.
  const digitCount = (suffix.match(/\d/g) ?? []).length;
  if (digitCount * 2 > suffix.length) {
    return CREDENTIAL_REF_REJECTED;
  }
  if (suffix.split('_').some((word) => RESERVED_SUFFIX_WORDS.has(word))) {
    return CREDENTIAL_REF_REJECTED;
  }
  if (containsSensitiveValue(value)) {
    return CREDENTIAL_REF_REJECTED;
  }
  return null;
}

// connectionNote is FREE TEXT for humans — never an address. The note is
// rejected when it smells like machine connection data, INDEPENDENT of
// whether credentials are embedded (Codex P1: a credential-free internal
// stream address is still a source URL).
const URI_SCHEME = /[a-z][a-z0-9+.-]*:\/\//i;
const SCHEME_COLON =
  /\b(rtsp|rtsps|rtmp|http|https|ws|wss|mqtt|tcp|udp|file|ftp|sftp|ssh|srt|postgres|postgresql|mysql|redis)\s*:/i;
const CONNECTION_KEY_VALUE =
  /\b(host|hostname|user|username|password|port|dbname|database)\s*=/i;
/** Dotted hostname: first label starts with a LETTER and the final label
 *  is alphabetic (camera.internal, cam-3.store.local) — measurements like
 *  "2.5m" or "aisle 3.5" start with digits and pass. */
const DOTTED_HOSTNAME = /\b(?=[a-z])[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}\b/i;
const IPV4_ADDRESS = /\b\d{1,3}(\.\d{1,3}){3}\b/;

const CONNECTION_NOTE_REJECTED =
  'connectionNote is free text only — URLs, hostnames, addresses, and ' +
  'connection strings are never stored (configure sources through ' +
  'operator-managed slots)';

/** Pure connectionNote screen — null = safe free text, else the
 *  controlled rejection message. */
export function connectionNoteViolation(note: string): string | null {
  if (
    URI_SCHEME.test(note) ||
    SCHEME_COLON.test(note) ||
    CONNECTION_KEY_VALUE.test(note) ||
    DOTTED_HOSTNAME.test(note) ||
    IPV4_ADDRESS.test(note)
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
