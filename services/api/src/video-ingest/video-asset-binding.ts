import { BadRequestException, Injectable } from '@nestjs/common';
import { PlanogramRackStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Phase 22 — planogram binding of a test clip: WHICH store and WHICH rack
 * the clip shows, captured at upload (or set afterwards) so every later
 * stage — fusion v2 candidate scoping, pretrained evaluation, planogram
 * narrowing — reads it from the asset instead of asking the operator
 * again. PURE parsing/validation helpers plus one read-only validator.
 *
 * Nothing here is a media surface: rack codes are operator identifiers
 * validated against the tenant's ACTIVE planogram racks, and the frame
 * region is four clamped numbers.
 */

export interface RackFrameRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

const RACK_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{0,31}$/;

/** Uppercased rack code or null when absent; 400 on an unsafe shape. */
export function normalizeRackCode(value: string | undefined | null): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const code = value.trim().toUpperCase();
  if (code.length === 0) {
    return null;
  }
  if (!RACK_CODE_PATTERN.test(code)) {
    throw new BadRequestException(
      'planogramRackCode must be 1-32 characters: letters, digits, "-" or "_"',
    );
  }
  return code;
}

function num01(value: unknown): number | null {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) && parsed >= 0 && parsed <= 1
    ? Math.round(parsed * 1000) / 1000
    : null;
}

/**
 * Parse a rack-frame region from a multipart string (JSON object) or an
 * already-parsed object. Returns null when absent; throws 400 on any
 * malformed value — a region that does not describe a rectangle inside
 * the frame is never stored.
 */
export function parseRackFrameRegion(
  value: unknown,
): RackFrameRegion | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  let raw: unknown = value;
  if (typeof value === 'string') {
    try {
      raw = JSON.parse(value);
    } catch {
      throw new BadRequestException('rackFrameRegion must be a JSON object {x,y,width,height}');
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BadRequestException('rackFrameRegion must be an object {x,y,width,height}');
  }
  const region = raw as Record<string, unknown>;
  const x = num01(region.x);
  const y = num01(region.y);
  const width = num01(region.width);
  const height = num01(region.height);
  if (
    x === null ||
    y === null ||
    width === null ||
    height === null ||
    width < 0.01 ||
    height < 0.01 ||
    x + width > 1.0005 ||
    y + height > 1.0005
  ) {
    throw new BadRequestException(
      'rackFrameRegion must be a rectangle inside the frame: x,y in 0..1, ' +
        'width,height in 0.01..1, and x+width, y+height at most 1',
    );
  }
  return { x, y, width: Math.min(width, 1 - x), height: Math.min(height, 1 - y) };
}

/** Allowlist rebuild of a STORED region on its way out (a hand-edited
 *  row cannot leak a different shape). */
export function sanitizeStoredRackFrameRegion(value: unknown): RackFrameRegion | null {
  try {
    return parseRackFrameRegion(value);
  } catch {
    return null;
  }
}

export interface VideoAssetBindingInput {
  locationId?: string | null;
  planogramRackCode?: string | null;
  rackFrameRegion?: unknown;
}

export interface ResolvedVideoAssetBinding {
  planogramRackCode: string | null;
  rackFrameRegion: RackFrameRegion | null;
}

/**
 * READ-ONLY validator: a rack code must name an ACTIVE planogram rack at
 * the bound store of the SAME tenant. Runs before any byte is stored.
 */
@Injectable()
export class VideoAssetBindingValidator {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(
    tenantId: string,
    input: VideoAssetBindingInput,
  ): Promise<ResolvedVideoAssetBinding> {
    const planogramRackCode = normalizeRackCode(input.planogramRackCode);
    const rackFrameRegion = parseRackFrameRegion(input.rackFrameRegion);
    if (planogramRackCode === null) {
      if (rackFrameRegion !== null) {
        throw new BadRequestException(
          'rackFrameRegion requires planogramRackCode (the rack the region frames)',
        );
      }
      return { planogramRackCode: null, rackFrameRegion: null };
    }
    if (!input.locationId) {
      throw new BadRequestException(
        'planogramRackCode requires locationId: a rack belongs to a store',
      );
    }
    const rack = await this.prisma.planogramRack.findFirst({
      where: {
        tenantId,
        locationId: input.locationId,
        rackCode: planogramRackCode,
        status: PlanogramRackStatus.ACTIVE,
      },
      select: { id: true },
    });
    if (!rack) {
      throw new BadRequestException(
        `No ACTIVE planogram rack "${planogramRackCode}" at the selected store — publish the layout first`,
      );
    }
    return { planogramRackCode, rackFrameRegion };
  }
}
