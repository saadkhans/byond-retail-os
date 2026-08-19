import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CameraCalibrationMount,
  CameraCalibrationOrientation,
  CameraCalibrationProfile,
  CameraCalibrationProfileStatus,
  CameraCalibrationZone,
  CameraCalibrationZoneType,
  CameraSourceStatus,
  CameraSourceType,
  CustomerJourneyDecision,
  LiveCameraSessionStatus,
  Prisma,
} from '@prisma/client';
import { containsSourceOrPathText } from '../common/free-text-safety';
import { cameraCalibrationAdvisoryLockKey } from '../common/locks';
import { PrismaService } from '../prisma/prisma.service';
import { containsSensitiveFreeText } from '../video-ingest/media-safety';
import {
  CALIBRATION_EXPECTED_PRODUCTS_MAX,
  CALIBRATION_LABEL_MAX_LENGTH,
  CALIBRATION_NAME_MAX_LENGTH,
  CALIBRATION_NOTES_MAX_LENGTH,
  CreateCalibrationProfileDto,
  CreateCalibrationZoneDto,
  UpdateCalibrationProfileDto,
  UpdateCalibrationZoneDto,
} from './dto/camera-calibration.dto';

/**
 * Phase 17 — camera calibration & pilot hardening (SHADOW ONLY).
 *
 * A calibration profile captures SAFE, structured setup metadata for one
 * camera source plus normalized shelf/interaction/ignore zones, used
 * only to make live CV testing more reliable and repeatable. NOTHING
 * here stores or returns an RTSP URL, file path, credential slot, raw
 * frame, or raw video, and no calibration path touches checkout, order,
 * payment, basket, or inventory state — the camera module's shadow-mode
 * spec enforces that statically in CI.
 */

export const POLYGON_MIN_POINTS = 3;
export const POLYGON_MAX_POINTS = 20;
export const MAX_ZONES_PER_PROFILE = 50;

/** Controlled readiness warning vocabulary — never raw exception text. */
export const CALIBRATION_WARNINGS = [
  'NO_ACTIVE_CALIBRATION_PROFILE',
  'NO_SHELF_ZONE',
  'NO_INTERACTION_ZONE',
  'NO_EXPECTED_PRODUCTS',
  'FRAME_DIMENSIONS_UNKNOWN',
  'ORIENTATION_UNKNOWN',
  'CAMERA_MOUNT_UNKNOWN',
  'SOURCE_NOT_ACTIVE',
  'LIVE_SESSION_ALREADY_ACTIVE',
] as const;
export type CalibrationWarning = (typeof CALIBRATION_WARNINGS)[number];

/** Warnings that make the source NOT_READY for real-footage testing. */
const BLOCKING_WARNINGS: readonly CalibrationWarning[] = [
  'NO_ACTIVE_CALIBRATION_PROFILE',
  'NO_SHELF_ZONE',
  'NO_INTERACTION_ZONE',
  'SOURCE_NOT_ACTIVE',
];

/** Controlled operator next-action vocabulary. */
export const PILOT_NEXT_ACTIONS = [
  'CREATE_CALIBRATION_PROFILE',
  'ADD_SHELF_ZONE',
  'ADD_INTERACTION_ZONE',
  'ASSIGN_EXPECTED_PRODUCTS',
  'IMPROVE_CAMERA_ANGLE',
  'CHECK_LIGHTING',
  'REDUCE_OCCLUSION',
  'REVIEW_MISSED_EVENTS',
  'RUN_PHASE16_TEST_PROTOCOL',
  'EXPORT_REVIEWED_DATASET',
] as const;
export type PilotNextAction = (typeof PILOT_NEXT_ACTIONS)[number];

/** Zones with a stated quality below this suggest a physical setup fix. */
export const ZONE_QUALITY_ATTENTION_THRESHOLD = 0.5;

const NON_TERMINAL_SESSION_STATUSES: LiveCameraSessionStatus[] = [
  LiveCameraSessionStatus.STARTING,
  LiveCameraSessionStatus.RUNNING,
  LiveCameraSessionStatus.STOPPING,
];

export interface CalibrationPoint {
  x: number;
  y: number;
}

const POLYGON_REJECTED =
  'polygon must be an array of 3 to 20 {x, y} points with every ' +
  'coordinate a number between 0 and 1 (normalized — never raw pixels)';

/**
 * MVP polygon validation (exported for direct testing): 3..20 points,
 * each an object with finite numeric x/y in [0, 1]. Returns a
 * WHITELISTED copy ({x, y} only) so no extra caller-supplied keys are
 * ever persisted into the Json column.
 */
export function validatePolygon(value: unknown): CalibrationPoint[] {
  if (!Array.isArray(value)) {
    throw new BadRequestException(POLYGON_REJECTED);
  }
  if (value.length < POLYGON_MIN_POINTS || value.length > POLYGON_MAX_POINTS) {
    throw new BadRequestException(POLYGON_REJECTED);
  }
  return value.map((point) => {
    if (typeof point !== 'object' || point === null || Array.isArray(point)) {
      throw new BadRequestException(POLYGON_REJECTED);
    }
    const { x, y } = point as Record<string, unknown>;
    for (const coordinate of [x, y]) {
      if (
        typeof coordinate !== 'number' ||
        !Number.isFinite(coordinate) ||
        coordinate < 0 ||
        coordinate > 1
      ) {
        throw new BadRequestException(POLYGON_REJECTED);
      }
    }
    return { x: x as number, y: y as number };
  });
}

export interface CalibrationProfileView {
  id: string;
  cameraSourceId: string;
  locationId: string | null;
  name: string;
  status: CameraCalibrationProfileStatus;
  calibrationVersion: number;
  frameWidth: number | null;
  frameHeight: number | null;
  orientation: CameraCalibrationOrientation;
  cameraMount: CameraCalibrationMount;
  notes: string | null;
  zoneCount: number;
  createdAt: Date;
  updatedAt: Date;
  activatedAt: Date | null;
  archivedAt: Date | null;
}

export interface CalibrationZoneView {
  id: string;
  calibrationProfileId: string;
  cameraSourceId: string;
  zoneType: CameraCalibrationZoneType;
  label: string;
  polygon: CalibrationPoint[];
  qualityScore: number | null;
  isActive: boolean;
  sortOrder: number;
  expectedProducts: { productId: string; sku: string }[];
  createdAt: Date;
  updatedAt: Date;
}

/** The ONE profile response mapper — tenantId never leaves the API. */
export function toCalibrationProfileView(
  profile: CameraCalibrationProfile,
  zoneCount: number,
): CalibrationProfileView {
  return {
    id: profile.id,
    cameraSourceId: profile.cameraSourceId,
    locationId: profile.locationId,
    name: profile.name,
    status: profile.status,
    calibrationVersion: profile.calibrationVersion,
    frameWidth: profile.frameWidth,
    frameHeight: profile.frameHeight,
    orientation: profile.orientation,
    cameraMount: profile.cameraMount,
    notes: profile.notes,
    zoneCount,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
    activatedAt: profile.activatedAt,
    archivedAt: profile.archivedAt,
  };
}

/** The ONE zone response mapper. */
export function toCalibrationZoneView(
  zone: CameraCalibrationZone,
  expectedProducts: { productId: string; sku: string }[],
): CalibrationZoneView {
  return {
    id: zone.id,
    calibrationProfileId: zone.calibrationProfileId,
    cameraSourceId: zone.cameraSourceId,
    zoneType: zone.zoneType,
    label: zone.label,
    polygon: Array.isArray(zone.polygon)
      ? (zone.polygon as unknown as CalibrationPoint[])
      : [],
    qualityScore: zone.qualityScore,
    isActive: zone.isActive,
    sortOrder: zone.sortOrder,
    expectedProducts,
    createdAt: zone.createdAt,
    updatedAt: zone.updatedAt,
  };
}

export interface CalibrationReadiness {
  cameraSourceId: string;
  hasActiveCalibrationProfile: boolean;
  activeProfileId: string | null;
  profileStatus: 'ACTIVE' | null;
  hasShelfZone: boolean;
  hasInteractionZone: boolean;
  hasIgnoreZone: boolean;
  hasExpectedProducts: boolean;
  frameDimensionsKnown: boolean;
  orientationKnown: boolean;
  cameraMountKnown: boolean;
  zoneCount: number;
  expectedProductCount: number;
  readiness: 'READY' | 'WARNING' | 'NOT_READY';
  warnings: CalibrationWarning[];
}

/**
 * PURE derivation of calibration readiness for one camera source —
 * controlled enums/booleans/counts only, no fake data. Shared by the
 * calibration endpoints AND the Phase 16 live-test preflight (one
 * definition, no drift; no service-to-service DI cycle). Only isActive
 * zones of the ACTIVE profile count. Zone/metadata warnings are emitted
 * only when an active profile exists — without one,
 * NO_ACTIVE_CALIBRATION_PROFILE already says everything actionable.
 */
export async function computeCalibrationReadiness(
  prisma: PrismaService,
  tenantId: string,
  source: { id: string; status: CameraSourceStatus },
): Promise<CalibrationReadiness> {
  const profile = await prisma.cameraCalibrationProfile.findFirst({
    where: {
      tenantId,
      cameraSourceId: source.id,
      status: CameraCalibrationProfileStatus.ACTIVE,
    },
  });
  const zones = profile
    ? await prisma.cameraCalibrationZone.findMany({
        where: {
          tenantId,
          calibrationProfileId: profile.id,
          isActive: true,
        },
      })
    : [];
  const shelfZoneIds = zones
    .filter((zone) => zone.zoneType === CameraCalibrationZoneType.SHELF_ZONE)
    .map((zone) => zone.id);
  const expectedProducts = shelfZoneIds.length
    ? await prisma.cameraCalibrationZoneProduct.findMany({
        where: { tenantId, zoneId: { in: shelfZoneIds } },
        select: { id: true },
      })
    : [];
  const activeSession = await prisma.liveCameraSession.findFirst({
    where: {
      tenantId,
      cameraSourceId: source.id,
      status: { in: NON_TERMINAL_SESSION_STATUSES },
    },
    select: { id: true },
  });

  const hasShelfZone = shelfZoneIds.length > 0;
  const hasInteractionZone = zones.some(
    (zone) => zone.zoneType === CameraCalibrationZoneType.INTERACTION_ZONE,
  );
  const hasIgnoreZone = zones.some(
    (zone) => zone.zoneType === CameraCalibrationZoneType.IGNORE_ZONE,
  );
  const frameDimensionsKnown =
    profile !== null &&
    profile.frameWidth !== null &&
    profile.frameHeight !== null;
  const orientationKnown =
    profile !== null &&
    profile.orientation !== CameraCalibrationOrientation.UNKNOWN;
  const cameraMountKnown =
    profile !== null && profile.cameraMount !== CameraCalibrationMount.UNKNOWN;

  const warnings: CalibrationWarning[] = [];
  if (!profile) {
    warnings.push('NO_ACTIVE_CALIBRATION_PROFILE');
  } else {
    if (!hasShelfZone) {
      warnings.push('NO_SHELF_ZONE');
    }
    if (!hasInteractionZone) {
      warnings.push('NO_INTERACTION_ZONE');
    }
    if (expectedProducts.length === 0) {
      warnings.push('NO_EXPECTED_PRODUCTS');
    }
    if (!frameDimensionsKnown) {
      warnings.push('FRAME_DIMENSIONS_UNKNOWN');
    }
    if (!orientationKnown) {
      warnings.push('ORIENTATION_UNKNOWN');
    }
    if (!cameraMountKnown) {
      warnings.push('CAMERA_MOUNT_UNKNOWN');
    }
  }
  if (source.status !== CameraSourceStatus.ACTIVE) {
    warnings.push('SOURCE_NOT_ACTIVE');
  }
  if (activeSession !== null) {
    warnings.push('LIVE_SESSION_ALREADY_ACTIVE');
  }

  const notReady = warnings.some((warning) =>
    BLOCKING_WARNINGS.includes(warning),
  );
  return {
    cameraSourceId: source.id,
    hasActiveCalibrationProfile: profile !== null,
    activeProfileId: profile?.id ?? null,
    profileStatus: profile ? 'ACTIVE' : null,
    hasShelfZone,
    hasInteractionZone,
    hasIgnoreZone,
    hasExpectedProducts: expectedProducts.length > 0,
    frameDimensionsKnown,
    orientationKnown,
    cameraMountKnown,
    zoneCount: zones.length,
    expectedProductCount: expectedProducts.length,
    readiness: notReady ? 'NOT_READY' : warnings.length ? 'WARNING' : 'READY',
    warnings,
  };
}

/** Minimal shape of the Phase 14 performance Json (local copy — a type
 *  import from live-session.service would create a module cycle). */
interface PerformanceJson {
  fastMode?: boolean;
  stages?: Record<string, { p95Ms: number; maxMs: number }>;
}

const ACTIVATION_NEEDS_ZONES =
  'activation requires at least one active SHELF_ZONE and one active ' +
  'INTERACTION_ZONE on this profile';

@Injectable()
export class CameraCalibrationService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * ONE serialization boundary for profile activation, keyed by CAMERA
   * SOURCE (Codex P1 discipline): archive-the-previous + promote-this
   * decide from in-transaction re-reads under the lock; the partial
   * unique index (one ACTIVE per source) backstops at the DB level.
   */
  private withSourceLock<T>(
    tenantId: string,
    cameraSourceId: string,
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${cameraCalibrationAdvisoryLockKey(
        tenantId,
        cameraSourceId,
      )}))::text`;
      return work(tx);
    });
  }

  /** Free-text screen (reject-on-write, never echoed back): shared
   *  sensitive-text predicate + the no-source/no-path screen + length
   *  cap. Same policy as Phase 16 protocol text. */
  private screenText(
    label: string,
    value: string | null | undefined,
    maxLength: number,
  ): string | null {
    const text = (value ?? '').trim();
    if (!text) {
      return null;
    }
    if (text.length > maxLength) {
      throw new BadRequestException(
        `${label} must be at most ${maxLength} characters`,
      );
    }
    if (containsSensitiveFreeText(text)) {
      throw new BadRequestException(
        `${label} rejected by the sensitive-content screen`,
      );
    }
    if (containsSourceOrPathText(text)) {
      throw new BadRequestException(
        `${label} rejected: URLs and file paths are not allowed in ` +
          'calibration text',
      );
    }
    return text;
  }

  private async requireProfile(
    tenantId: string,
    profileId: string,
  ): Promise<CameraCalibrationProfile> {
    const profile = await this.prisma.cameraCalibrationProfile.findFirst({
      where: { tenantId, id: profileId },
    });
    if (!profile) {
      throw new NotFoundException('Calibration profile not found');
    }
    return profile;
  }

  private async zoneCounts(
    tenantId: string,
    profileIds: string[],
  ): Promise<Map<string, number>> {
    if (profileIds.length === 0) {
      return new Map();
    }
    const zones = await this.prisma.cameraCalibrationZone.findMany({
      where: { tenantId, calibrationProfileId: { in: profileIds } },
      select: { calibrationProfileId: true },
    });
    const counts = new Map<string, number>();
    for (const zone of zones) {
      counts.set(
        zone.calibrationProfileId,
        (counts.get(zone.calibrationProfileId) ?? 0) + 1,
      );
    }
    return counts;
  }

  private async expectedProductsByZone(
    tenantId: string,
    zoneIds: string[],
  ): Promise<Map<string, { productId: string; sku: string }[]>> {
    const map = new Map<string, { productId: string; sku: string }[]>();
    if (zoneIds.length === 0) {
      return map;
    }
    const rows = await this.prisma.cameraCalibrationZoneProduct.findMany({
      where: { tenantId, zoneId: { in: zoneIds } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    for (const row of rows) {
      const list = map.get(row.zoneId) ?? [];
      list.push({ productId: row.productId, sku: row.expectedSku });
      map.set(row.zoneId, list);
    }
    return map;
  }

  /** Tenant-scoped BATCH product validation: every id must resolve
   *  within THIS tenant; the SKU is snapshotted (house pattern). */
  private async resolveExpectedProducts(
    tenantId: string,
    productIds: string[],
  ): Promise<{ productId: string; sku: string }[]> {
    const unique = [...new Set(productIds)];
    if (unique.length === 0) {
      return [];
    }
    if (unique.length > CALIBRATION_EXPECTED_PRODUCTS_MAX) {
      throw new BadRequestException(
        `at most ${CALIBRATION_EXPECTED_PRODUCTS_MAX} expected products ` +
          'per shelf zone',
      );
    }
    const products = await this.prisma.product.findMany({
      where: { tenantId, id: { in: unique } },
      select: { id: true, sku: true },
    });
    if (products.length !== unique.length) {
      throw new NotFoundException('Expected product not found in this tenant');
    }
    return products.map((product) => ({
      productId: product.id,
      sku: product.sku,
    }));
  }

  // ------------------------------------------------------------------
  // Profiles
  // ------------------------------------------------------------------

  async createProfile(
    tenantId: string,
    input: CreateCalibrationProfileDto,
    actorId?: string,
  ): Promise<CalibrationProfileView> {
    const source = await this.prisma.cameraSource.findFirst({
      where: { tenantId, id: input.cameraSourceId },
      select: { id: true, locationId: true },
    });
    if (!source) {
      throw new NotFoundException('Camera source not found');
    }
    if (input.locationId) {
      const location = await this.prisma.location.findFirst({
        where: { tenantId, id: input.locationId },
        select: { id: true },
      });
      if (!location) {
        throw new NotFoundException('Store not found in this tenant');
      }
    }
    const name = this.screenText(
      'name',
      input.name,
      CALIBRATION_NAME_MAX_LENGTH,
    );
    if (!name) {
      throw new BadRequestException('name is required');
    }
    const created = await this.prisma.cameraCalibrationProfile.create({
      data: {
        tenantId,
        cameraSourceId: input.cameraSourceId,
        locationId: input.locationId ?? source.locationId ?? null,
        name,
        status: CameraCalibrationProfileStatus.DRAFT,
        calibrationVersion: 1,
        activatedAt: null,
        archivedAt: null,
        frameWidth: input.frameWidth ?? null,
        frameHeight: input.frameHeight ?? null,
        orientation:
          input.orientation ?? CameraCalibrationOrientation.UNKNOWN,
        cameraMount: input.cameraMount ?? CameraCalibrationMount.UNKNOWN,
        notes: this.screenText(
          'notes',
          input.notes,
          CALIBRATION_NOTES_MAX_LENGTH,
        ),
        createdById: actorId ?? null,
      },
    });
    return toCalibrationProfileView(created, 0);
  }

  async listProfiles(
    tenantId: string,
    cameraSourceId?: string | null,
  ): Promise<CalibrationProfileView[]> {
    const profiles = await this.prisma.cameraCalibrationProfile.findMany({
      where: {
        tenantId,
        ...(cameraSourceId ? { cameraSourceId } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 100,
    });
    const counts = await this.zoneCounts(
      tenantId,
      profiles.map((profile) => profile.id),
    );
    return profiles.map((profile) =>
      toCalibrationProfileView(profile, counts.get(profile.id) ?? 0),
    );
  }

  async profileById(
    tenantId: string,
    profileId: string,
  ): Promise<CalibrationProfileView & { zones: CalibrationZoneView[] }> {
    const profile = await this.requireProfile(tenantId, profileId);
    const zones = await this.prisma.cameraCalibrationZone.findMany({
      where: { tenantId, calibrationProfileId: profile.id },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    const products = await this.expectedProductsByZone(
      tenantId,
      zones.map((zone) => zone.id),
    );
    return {
      ...toCalibrationProfileView(profile, zones.length),
      zones: zones.map((zone) =>
        toCalibrationZoneView(zone, products.get(zone.id) ?? []),
      ),
    };
  }

  async updateProfile(
    tenantId: string,
    profileId: string,
    input: UpdateCalibrationProfileDto,
  ): Promise<CalibrationProfileView> {
    const profile = await this.requireProfile(tenantId, profileId);
    if (profile.status === CameraCalibrationProfileStatus.ARCHIVED) {
      throw new BadRequestException(
        'an ARCHIVED calibration profile is immutable — create a new one',
      );
    }
    if (input.locationId) {
      const location = await this.prisma.location.findFirst({
        where: { tenantId, id: input.locationId },
        select: { id: true },
      });
      if (!location) {
        throw new NotFoundException('Store not found in this tenant');
      }
    }
    const data: Prisma.CameraCalibrationProfileUpdateInput = {};
    if (input.name !== undefined) {
      const name = this.screenText(
        'name',
        input.name,
        CALIBRATION_NAME_MAX_LENGTH,
      );
      if (!name) {
        throw new BadRequestException('name must not be blank');
      }
      data.name = name;
    }
    if (input.locationId !== undefined) {
      data.location = { connect: { id: input.locationId } };
    }
    if (input.frameWidth !== undefined) {
      data.frameWidth = input.frameWidth;
    }
    if (input.frameHeight !== undefined) {
      data.frameHeight = input.frameHeight;
    }
    if (input.orientation !== undefined) {
      data.orientation = input.orientation;
    }
    if (input.cameraMount !== undefined) {
      data.cameraMount = input.cameraMount;
    }
    if (input.notes !== undefined) {
      data.notes = this.screenText(
        'notes',
        input.notes,
        CALIBRATION_NOTES_MAX_LENGTH,
      );
    }
    const updated = await this.prisma.cameraCalibrationProfile.update({
      where: { id_tenantId: { id: profileId, tenantId } },
      data,
    });
    const counts = await this.zoneCounts(tenantId, [profileId]);
    return toCalibrationProfileView(updated, counts.get(profileId) ?? 0);
  }

  /**
   * EXPLICIT activation: requires at least one active SHELF_ZONE and one
   * active INTERACTION_ZONE, archives the source's current ACTIVE
   * profile, and promotes this one — all under the source-scoped
   * advisory lock from in-transaction re-reads.
   */
  async activateProfile(
    tenantId: string,
    profileId: string,
  ): Promise<CalibrationProfileView> {
    const profile = await this.requireProfile(tenantId, profileId);
    const activated = await this.withSourceLock(
      tenantId,
      profile.cameraSourceId,
      async (tx) => {
        const current = await tx.cameraCalibrationProfile.findFirst({
          where: { tenantId, id: profileId },
        });
        if (!current) {
          throw new NotFoundException('Calibration profile not found');
        }
        if (current.status === CameraCalibrationProfileStatus.ARCHIVED) {
          throw new BadRequestException(
            'an ARCHIVED calibration profile cannot be activated — ' +
              'create a new one',
          );
        }
        const zones = await tx.cameraCalibrationZone.findMany({
          where: {
            tenantId,
            calibrationProfileId: profileId,
            isActive: true,
          },
          select: { zoneType: true },
        });
        const hasShelf = zones.some(
          (zone) => zone.zoneType === CameraCalibrationZoneType.SHELF_ZONE,
        );
        const hasInteraction = zones.some(
          (zone) =>
            zone.zoneType === CameraCalibrationZoneType.INTERACTION_ZONE,
        );
        if (!hasShelf || !hasInteraction) {
          throw new BadRequestException(ACTIVATION_NEEDS_ZONES);
        }
        // Archive the previous ACTIVE profile (if any) — one ACTIVE per
        // source, and the DB partial unique backstops the invariant.
        await tx.cameraCalibrationProfile.updateMany({
          where: {
            tenantId,
            cameraSourceId: current.cameraSourceId,
            status: CameraCalibrationProfileStatus.ACTIVE,
            id: { not: profileId },
          },
          data: {
            status: CameraCalibrationProfileStatus.ARCHIVED,
            archivedAt: new Date(),
          },
        });
        return tx.cameraCalibrationProfile.update({
          where: { id_tenantId: { id: profileId, tenantId } },
          data: {
            status: CameraCalibrationProfileStatus.ACTIVE,
            activatedAt: new Date(),
          },
        });
      },
    );
    const counts = await this.zoneCounts(tenantId, [profileId]);
    return toCalibrationProfileView(activated, counts.get(profileId) ?? 0);
  }

  async archiveProfile(
    tenantId: string,
    profileId: string,
  ): Promise<CalibrationProfileView> {
    const profile = await this.requireProfile(tenantId, profileId);
    if (profile.status === CameraCalibrationProfileStatus.ARCHIVED) {
      throw new BadRequestException(
        'calibration profile is already archived',
      );
    }
    const archived = await this.prisma.cameraCalibrationProfile.update({
      where: { id_tenantId: { id: profileId, tenantId } },
      data: {
        status: CameraCalibrationProfileStatus.ARCHIVED,
        archivedAt: new Date(),
      },
    });
    const counts = await this.zoneCounts(tenantId, [profileId]);
    return toCalibrationProfileView(archived, counts.get(profileId) ?? 0);
  }

  // ------------------------------------------------------------------
  // Zones
  // ------------------------------------------------------------------

  private assertZoneWritable(profile: CameraCalibrationProfile): void {
    if (profile.status === CameraCalibrationProfileStatus.ARCHIVED) {
      throw new BadRequestException(
        'zones of an ARCHIVED calibration profile are immutable',
      );
    }
  }

  async addZone(
    tenantId: string,
    profileId: string,
    input: CreateCalibrationZoneDto,
  ): Promise<CalibrationZoneView> {
    const profile = await this.requireProfile(tenantId, profileId);
    this.assertZoneWritable(profile);
    const label = this.screenText(
      'label',
      input.label,
      CALIBRATION_LABEL_MAX_LENGTH,
    );
    if (!label) {
      throw new BadRequestException('label is required');
    }
    const polygon = validatePolygon(input.polygon);
    if (
      input.expectedProductIds?.length &&
      input.zoneType !== CameraCalibrationZoneType.SHELF_ZONE
    ) {
      throw new BadRequestException(
        'expectedProductIds apply to SHELF_ZONE zones only',
      );
    }
    const expected = await this.resolveExpectedProducts(
      tenantId,
      input.expectedProductIds ?? [],
    );
    const existing = await this.prisma.cameraCalibrationZone.findMany({
      where: { tenantId, calibrationProfileId: profileId },
      select: { id: true },
    });
    if (existing.length >= MAX_ZONES_PER_PROFILE) {
      throw new BadRequestException(
        `a calibration profile holds at most ${MAX_ZONES_PER_PROFILE} zones`,
      );
    }
    const zone = await this.prisma.$transaction(async (tx) => {
      const created = await tx.cameraCalibrationZone.create({
        data: {
          tenantId,
          calibrationProfileId: profileId,
          cameraSourceId: profile.cameraSourceId,
          zoneType: input.zoneType,
          label,
          polygon: polygon as unknown as Prisma.InputJsonValue,
          qualityScore: input.qualityScore ?? null,
          isActive: input.isActive ?? true,
          sortOrder: input.sortOrder ?? 0,
        },
      });
      if (expected.length) {
        await tx.cameraCalibrationZoneProduct.createMany({
          data: expected.map((product) => ({
            tenantId,
            zoneId: created.id,
            productId: product.productId,
            expectedSku: product.sku,
          })),
        });
      }
      return created;
    });
    return toCalibrationZoneView(zone, expected);
  }

  private async requireZone(
    tenantId: string,
    profileId: string,
    zoneId: string,
  ): Promise<CameraCalibrationZone> {
    const zone = await this.prisma.cameraCalibrationZone.findFirst({
      where: { tenantId, id: zoneId, calibrationProfileId: profileId },
    });
    if (!zone) {
      throw new NotFoundException('Calibration zone not found');
    }
    return zone;
  }

  async updateZone(
    tenantId: string,
    profileId: string,
    zoneId: string,
    input: UpdateCalibrationZoneDto,
  ): Promise<CalibrationZoneView> {
    const profile = await this.requireProfile(tenantId, profileId);
    this.assertZoneWritable(profile);
    const zone = await this.requireZone(tenantId, profileId, zoneId);
    if (
      input.expectedProductIds?.length &&
      zone.zoneType !== CameraCalibrationZoneType.SHELF_ZONE
    ) {
      throw new BadRequestException(
        'expectedProductIds apply to SHELF_ZONE zones only',
      );
    }
    const expected =
      input.expectedProductIds !== undefined
        ? await this.resolveExpectedProducts(
            tenantId,
            input.expectedProductIds,
          )
        : null;
    const data: Prisma.CameraCalibrationZoneUpdateInput = {};
    if (input.label !== undefined) {
      const label = this.screenText(
        'label',
        input.label,
        CALIBRATION_LABEL_MAX_LENGTH,
      );
      if (!label) {
        throw new BadRequestException('label must not be blank');
      }
      data.label = label;
    }
    if (input.polygon !== undefined) {
      data.polygon = validatePolygon(
        input.polygon,
      ) as unknown as Prisma.InputJsonValue;
    }
    if (input.qualityScore !== undefined) {
      data.qualityScore = input.qualityScore;
    }
    if (input.isActive !== undefined) {
      data.isActive = input.isActive;
    }
    if (input.sortOrder !== undefined) {
      data.sortOrder = input.sortOrder;
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.cameraCalibrationZone.update({
        where: { id_tenantId: { id: zoneId, tenantId } },
        data,
      });
      if (expected !== null) {
        // REPLACE-ALL semantics for the expected-product set.
        await tx.cameraCalibrationZoneProduct.deleteMany({
          where: { tenantId, zoneId },
        });
        if (expected.length) {
          await tx.cameraCalibrationZoneProduct.createMany({
            data: expected.map((product) => ({
              tenantId,
              zoneId,
              productId: product.productId,
              expectedSku: product.sku,
            })),
          });
        }
      }
      return row;
    });
    const products =
      expected ??
      (await this.expectedProductsByZone(tenantId, [zoneId])).get(zoneId) ??
      [];
    return toCalibrationZoneView(updated, products);
  }

  async deleteZone(
    tenantId: string,
    profileId: string,
    zoneId: string,
  ): Promise<{ id: string; deleted: true }> {
    const profile = await this.requireProfile(tenantId, profileId);
    this.assertZoneWritable(profile);
    await this.requireZone(tenantId, profileId, zoneId);
    await this.prisma.$transaction(async (tx) => {
      // Explicit child cleanup (the DB cascade also covers this; the
      // in-memory test stubs do not implement cascades).
      await tx.cameraCalibrationZoneProduct.deleteMany({
        where: { tenantId, zoneId },
      });
      await tx.cameraCalibrationZone.delete({
        where: { id_tenantId: { id: zoneId, tenantId } },
      });
    });
    return { id: zoneId, deleted: true };
  }

  // ------------------------------------------------------------------
  // Readiness + pilot hardening report
  // ------------------------------------------------------------------

  async calibrationReadiness(
    tenantId: string,
    cameraSourceId: string,
  ): Promise<CalibrationReadiness> {
    const source = await this.prisma.cameraSource.findFirst({
      where: { tenantId, id: cameraSourceId },
      select: { id: true, status: true },
    });
    if (!source) {
      throw new NotFoundException('Camera source not found');
    }
    return computeCalibrationReadiness(this.prisma, tenantId, source);
  }

  /**
   * Pilot hardening report: everything the operator needs BEFORE a live
   * test — source status, calibration readiness, zone/product coverage,
   * the latest live session and its performance (null when absent,
   * never fabricated), and a controlled next-action list.
   */
  async pilotHardeningReport(tenantId: string, cameraSourceId: string) {
    const source = await this.prisma.cameraSource.findFirst({
      where: { tenantId, id: cameraSourceId },
      select: { id: true, status: true, sourceType: true },
    });
    if (!source) {
      throw new NotFoundException('Camera source not found');
    }
    const readiness = await computeCalibrationReadiness(
      this.prisma,
      tenantId,
      source,
    );
    const activeProfile = readiness.activeProfileId
      ? await this.prisma.cameraCalibrationProfile.findFirst({
          where: { tenantId, id: readiness.activeProfileId },
        })
      : null;
    const zones = activeProfile
      ? await this.prisma.cameraCalibrationZone.findMany({
          where: {
            tenantId,
            calibrationProfileId: activeProfile.id,
            isActive: true,
          },
        })
      : [];
    const shelfZoneIds = zones
      .filter((zone) => zone.zoneType === CameraCalibrationZoneType.SHELF_ZONE)
      .map((zone) => zone.id);
    const zoneProducts = shelfZoneIds.length
      ? await this.prisma.cameraCalibrationZoneProduct.findMany({
          where: { tenantId, zoneId: { in: shelfZoneIds } },
          select: { zoneId: true },
        })
      : [];
    const latestSession = await this.prisma.liveCameraSession.findFirst({
      where: { tenantId, cameraSourceId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    const performance =
      latestSession?.performance &&
      typeof latestSession.performance === 'object'
        ? (latestSession.performance as unknown as PerformanceJson)
        : null;
    let slowestStage: { stage: string; p95Ms: number; maxMs: number } | null =
      null;
    for (const [stage, stats] of Object.entries(performance?.stages ?? {})) {
      if (!slowestStage || stats.p95Ms > slowestStage.p95Ms) {
        slowestStage = { stage, p95Ms: stats.p95Ms, maxMs: stats.maxMs };
      }
    }

    const actions: PilotNextAction[] = [];
    if (!readiness.hasActiveCalibrationProfile) {
      actions.push('CREATE_CALIBRATION_PROFILE');
    }
    if (readiness.hasActiveCalibrationProfile && !readiness.hasShelfZone) {
      actions.push('ADD_SHELF_ZONE');
    }
    if (
      readiness.hasActiveCalibrationProfile &&
      !readiness.hasInteractionZone
    ) {
      actions.push('ADD_INTERACTION_ZONE');
    }
    if (
      readiness.hasActiveCalibrationProfile &&
      readiness.hasShelfZone &&
      !readiness.hasExpectedProducts
    ) {
      actions.push('ASSIGN_EXPECTED_PRODUCTS');
    }
    if (activeProfile && !readiness.cameraMountKnown) {
      actions.push('IMPROVE_CAMERA_ANGLE');
    }
    const lowQualityZone = zones.some(
      (zone) =>
        zone.qualityScore !== null &&
        zone.qualityScore < ZONE_QUALITY_ATTENTION_THRESHOLD,
    );
    if (lowQualityZone) {
      actions.push('CHECK_LIGHTING', 'REDUCE_OCCLUSION');
    }
    if ((latestSession?.reviewNeeded ?? 0) > 0) {
      actions.push('REVIEW_MISSED_EVENTS');
    }
    if (readiness.readiness === 'READY') {
      const protocol = await this.prisma.cvTestProtocol.findFirst({
        where: { tenantId, cameraSourceId },
        select: { id: true },
      });
      if (!protocol) {
        actions.push('RUN_PHASE16_TEST_PROTOCOL');
      }
    }
    const exportableProtocol = await this.prisma.cvTestProtocol.findFirst({
      where: {
        tenantId,
        cameraSourceId,
        status: 'COMPLETED',
        evaluationRunId: { not: null },
      },
      select: { id: true },
    });
    if (exportableProtocol) {
      actions.push('EXPORT_REVIEWED_DATASET');
    }

    return {
      cameraSourceId,
      sourceStatus: source.status,
      sourceType: source.sourceType as CameraSourceType,
      calibrationReadiness: readiness,
      activeCalibrationProfile: activeProfile
        ? toCalibrationProfileView(activeProfile, zones.length)
        : null,
      zoneSummary: {
        total: zones.length,
        shelfZones: shelfZoneIds.length,
        interactionZones: zones.filter(
          (zone) =>
            zone.zoneType === CameraCalibrationZoneType.INTERACTION_ZONE,
        ).length,
        ignoreZones: zones.filter(
          (zone) => zone.zoneType === CameraCalibrationZoneType.IGNORE_ZONE,
        ).length,
        entryExitZones: zones.filter(
          (zone) =>
            zone.zoneType === CameraCalibrationZoneType.ENTRY_EXIT_ZONE,
        ).length,
      },
      expectedProductsSummary: {
        shelfZonesWithProducts: new Set(
          zoneProducts.map((row) => row.zoneId),
        ).size,
        productCount: zoneProducts.length,
      },
      latestLiveSessionSummary: latestSession
        ? {
            id: latestSession.id,
            status: latestSession.status,
            startedAt: latestSession.startedAt,
            stoppedAt: latestSession.stoppedAt,
            framesSampled: latestSession.framesSampled,
            eventWindowsDetected: latestSession.eventWindowsDetected,
            reviewNeeded: latestSession.reviewNeeded,
            decision: latestSession.decision as CustomerJourneyDecision | null,
          }
        : null,
      latestPerformanceSummary: performance
        ? { fastMode: performance.fastMode ?? null, slowestStage }
        : null,
      recommendedNextActions: actions,
      safety: {
        orders: 0,
        checkoutSessions: 0,
        paymentIntents: 0,
        paymentEvents: 0,
        inventoryMovements: 0,
        // Structural zeros: the camera module has no delegate access to
        // these tables (CI-enforced static guard).
        basis: 'SHADOW_MODE_STATIC_GUARD',
      },
    };
  }
}
