import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  CameraCalibrationService,
  MAX_ZONES_PER_PROFILE,
  PILOT_NEXT_ACTIONS,
  validatePolygon,
} from './camera-calibration.service';

const TENANT = 'tenant-1';
const OTHER_TENANT = 'tenant-2';

/** Runtime-assembled risky needles (same idiom as the camera-sources
 *  specs): no URL/secret-shaped literal ever appears in this file. */
const assemble = (...parts: string[]) => parts.join('');
const LEAK_NEEDLES = [
  assemble('rt', 'sp'),
  assemble(':', '/', '/'),
  assemble('CAMERA_SECRET', '_SLOT'),
  assemble('.m', 'p4'),
  'credentialRef',
];

const SQUARE = [
  { x: 0.1, y: 0.1 },
  { x: 0.9, y: 0.1 },
  { x: 0.9, y: 0.9 },
  { x: 0.1, y: 0.9 },
];

interface Row {
  [key: string]: unknown;
}

function buildHarness(seed?: {
  sources?: Row[];
  locations?: Row[];
  products?: Row[];
  profiles?: Row[];
  zones?: Row[];
  zoneProducts?: Row[];
  sessions?: Row[];
  protocols?: Row[];
}) {
  const sources: Row[] = seed?.sources ?? [
    {
      id: 'cam-1',
      tenantId: TENANT,
      locationId: 'store-1',
      status: 'ACTIVE',
      sourceType: 'RTSP_SHADOW',
    },
  ];
  const locations: Row[] = seed?.locations ?? [
    { id: 'store-1', tenantId: TENANT },
  ];
  const products: Row[] = seed?.products ?? [
    { id: 'prod-1', tenantId: TENANT, sku: 'SKU-WATER' },
    { id: 'prod-2', tenantId: TENANT, sku: 'SKU-JUICE' },
    { id: 'prod-foreign', tenantId: OTHER_TENANT, sku: 'SKU-FOREIGN' },
  ];
  const profiles: Row[] = seed?.profiles ?? [];
  const zones: Row[] = seed?.zones ?? [];
  const zoneProducts: Row[] = seed?.zoneProducts ?? [];
  const sessions: Row[] = seed?.sessions ?? [];
  const protocols: Row[] = seed?.protocols ?? [];

  const matches = (row: Row, where: Row | undefined): boolean =>
    Object.entries(where ?? {}).every(([key, cond]) => {
      if (
        cond !== null &&
        typeof cond === 'object' &&
        !(cond instanceof Date)
      ) {
        const clause = cond as { in?: unknown[]; not?: unknown };
        if ('in' in clause) {
          return (clause.in as unknown[]).includes(row[key]);
        }
        if ('not' in clause) {
          return (row[key] ?? null) !== clause.not;
        }
        return true;
      }
      return (row[key] ?? null) === cond;
    });

  const byCreatedAtDesc = (rows: Row[]): Row[] =>
    [...rows].sort((a, b) => {
      const at = (a.createdAt as Date)?.getTime() ?? 0;
      const bt = (b.createdAt as Date)?.getTime() ?? 0;
      return bt - at || String(b.id).localeCompare(String(a.id));
    });

  let now = new Date('2026-08-19T10:00:00.000Z').getTime();
  const nextDate = () => new Date((now += 1000));
  let idCounter = 0;
  const nextId = (prefix: string) => `${prefix}-${++idCounter}`;

  const table = (rows: Row[], prefix: string) => ({
    create: jest.fn(async (args: { data: Row }) => {
      const row = {
        id: nextId(prefix),
        createdAt: nextDate(),
        updatedAt: nextDate(),
        ...args.data,
      };
      rows.push(row);
      return { ...row };
    }),
    createMany: jest.fn(async (args: { data: Row[] }) => {
      for (const data of args.data) {
        rows.push({ id: nextId(prefix), createdAt: nextDate(), ...data });
      }
      return { count: args.data.length };
    }),
    findFirst: jest.fn(
      async (args: { where?: Row; orderBy?: unknown }) => {
        const hits = rows.filter((row) => matches(row, args.where));
        const ordered = args.orderBy ? byCreatedAtDesc(hits) : hits;
        return ordered[0] ? { ...ordered[0] } : null;
      },
    ),
    findMany: jest.fn(async (args: { where?: Row; take?: number }) => {
      const hits = rows.filter((row) => matches(row, args.where));
      return hits.slice(0, args.take ?? hits.length).map((row) => ({
        ...row,
      }));
    }),
    update: jest.fn(
      async (args: {
        where: { id_tenantId: { id: string; tenantId: string } };
        data: Row;
      }) => {
        const row = rows.find(
          (candidate) =>
            candidate.id === args.where.id_tenantId.id &&
            candidate.tenantId === args.where.id_tenantId.tenantId,
        );
        if (!row) {
          throw new Error('row not found');
        }
        for (const [key, value] of Object.entries(args.data)) {
          if (key === 'location') {
            row.locationId = (
              value as { connect: { id: string } }
            ).connect.id;
          } else {
            row[key] = value;
          }
        }
        row.updatedAt = nextDate();
        return { ...row };
      },
    ),
    updateMany: jest.fn(async (args: { where: Row; data: Row }) => {
      const hits = rows.filter((row) => matches(row, args.where));
      for (const row of hits) {
        Object.assign(row, args.data);
      }
      return { count: hits.length };
    }),
    delete: jest.fn(
      async (args: {
        where: { id_tenantId: { id: string; tenantId: string } };
      }) => {
        const index = rows.findIndex(
          (candidate) =>
            candidate.id === args.where.id_tenantId.id &&
            candidate.tenantId === args.where.id_tenantId.tenantId,
        );
        const [removed] = index >= 0 ? rows.splice(index, 1) : [null];
        return removed;
      },
    ),
    deleteMany: jest.fn(async (args: { where: Row }) => {
      const keep = rows.filter((row) => !matches(row, args.where));
      const removed = rows.length - keep.length;
      rows.length = 0;
      rows.push(...keep);
      return { count: removed };
    }),
  });

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const prisma: any = {
    cameraSource: table(sources, 'cam'),
    location: table(locations, 'store'),
    product: table(products, 'prod'),
    cameraCalibrationProfile: table(profiles, 'calib'),
    cameraCalibrationZone: table(zones, 'zone'),
    cameraCalibrationZoneProduct: table(zoneProducts, 'zp'),
    liveCameraSession: table(sessions, 'live'),
    cvTestProtocol: table(protocols, 'proto'),
  };
  prisma.$transaction = jest.fn(
    async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
  );
  prisma.$queryRaw = jest.fn(async () => []);
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const service = new CameraCalibrationService(prisma);
  return {
    service,
    prisma,
    sources,
    profiles,
    zones,
    zoneProducts,
    sessions,
    protocols,
  };
}

/** A profile that satisfies activation: shelf + interaction zones. */
async function seedActivatedProfile(
  harness: ReturnType<typeof buildHarness>,
  options?: {
    frameKnown?: boolean;
    mountKnown?: boolean;
    orientationKnown?: boolean;
    expectedProducts?: boolean;
  },
) {
  const profile = await harness.service.createProfile(TENANT, {
    cameraSourceId: 'cam-1',
    name: 'front shelf calibration',
    ...(options?.frameKnown !== false
      ? { frameWidth: 1280, frameHeight: 720 }
      : {}),
    ...(options?.orientationKnown !== false
      ? { orientation: 'LANDSCAPE' as const }
      : {}),
    ...(options?.mountKnown !== false
      ? { cameraMount: 'FRONT_SHELF' as const }
      : {}),
  });
  await harness.service.addZone(TENANT, profile.id, {
    zoneType: 'SHELF_ZONE' as never,
    label: 'top shelf',
    polygon: SQUARE,
    ...(options?.expectedProducts !== false
      ? { expectedProductIds: ['prod-1'] }
      : {}),
  } as never);
  await harness.service.addZone(TENANT, profile.id, {
    zoneType: 'INTERACTION_ZONE' as never,
    label: 'reach in area',
    polygon: SQUARE,
  } as never);
  return harness.service.activateProfile(TENANT, profile.id);
}

describe('validatePolygon', () => {
  it('accepts 3..20 in-range points and whitelists {x, y}', () => {
    const result = validatePolygon([
      { x: 0, y: 0, extra: 'dropped' },
      { x: 1, y: 0 },
      { x: 0.5, y: 1 },
    ]);
    expect(result).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0.5, y: 1 },
    ]);
  });

  it('rejects fewer than 3 points, more than 20 points, out-of-range and malformed coordinates', () => {
    const bad = [
      'not-an-array',
      [{ x: 0, y: 0 }, { x: 1, y: 1 }],
      Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5 })),
      [{ x: -0.1, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }],
      [{ x: 0, y: 1.2 }, { x: 1, y: 0 }, { x: 0, y: 1 }],
      [{ x: '0.5', y: 0.5 }, { x: 1, y: 0 }, { x: 0, y: 1 }],
      [{ x: Number.NaN, y: 0.5 }, { x: 1, y: 0 }, { x: 0, y: 1 }],
      [null, { x: 1, y: 0 }, { x: 0, y: 1 }],
      [[0.5, 0.5], { x: 1, y: 0 }, { x: 0, y: 1 }],
    ];
    for (const polygon of bad) {
      expect(() => validatePolygon(polygon)).toThrow(BadRequestException);
    }
  });
});

describe('CameraCalibrationService — profiles', () => {
  it('creates a DRAFT profile (location defaulted from the source) and lists/details it', async () => {
    const harness = buildHarness();
    const created = await harness.service.createProfile(
      TENANT,
      { cameraSourceId: 'cam-1', name: 'front shelf calibration' },
      'user-1',
    );
    expect(created.status).toBe('DRAFT');
    expect(created.calibrationVersion).toBe(1);
    expect(created.locationId).toBe('store-1');
    expect(created.orientation).toBe('UNKNOWN');
    expect(created.cameraMount).toBe('UNKNOWN');
    expect(created.zoneCount).toBe(0);

    const list = await harness.service.listProfiles(TENANT, 'cam-1');
    expect(list).toHaveLength(1);
    const detail = await harness.service.profileById(TENANT, created.id);
    expect(detail.zones).toEqual([]);

    // No tenant id or risky material in any response.
    for (const payload of [created, list, detail]) {
      const raw = JSON.stringify(payload);
      expect(raw).not.toContain('tenantId');
      for (const needle of LEAK_NEEDLES) {
        expect(raw).not.toContain(needle);
      }
    }
  });

  it('is tenant-isolated end to end: foreign source, foreign profile, foreign list', async () => {
    const harness = buildHarness();
    await expect(
      harness.service.createProfile(OTHER_TENANT, {
        cameraSourceId: 'cam-1',
        name: 'x',
      }),
    ).rejects.toThrow(NotFoundException);

    const mine = await harness.service.createProfile(TENANT, {
      cameraSourceId: 'cam-1',
      name: 'mine',
    });
    await expect(
      harness.service.profileById(OTHER_TENANT, mine.id),
    ).rejects.toThrow(NotFoundException);
    await expect(
      harness.service.updateProfile(OTHER_TENANT, mine.id, { name: 'stolen' }),
    ).rejects.toThrow(NotFoundException);
    await expect(
      harness.service.activateProfile(OTHER_TENANT, mine.id),
    ).rejects.toThrow(NotFoundException);
    expect(await harness.service.listProfiles(OTHER_TENANT, 'cam-1')).toEqual(
      [],
    );
  });

  it('screens notes and name: URL-, path-, and credential-shaped text is rejected, never stored', async () => {
    const harness = buildHarness();
    const riskyNote = assemble('rt', 'sp', ':', '/', '/cam3/stream');
    await expect(
      harness.service.createProfile(TENANT, {
        cameraSourceId: 'cam-1',
        name: 'ok name',
        notes: riskyNote,
      }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      harness.service.createProfile(TENANT, {
        cameraSourceId: 'cam-1',
        name: 'ok name',
        notes: assemble('see C:', '\\videos\\clip'),
      }),
    ).rejects.toThrow(BadRequestException);
    expect(harness.profiles).toHaveLength(0);
  });

  it('updates metadata on DRAFT/ACTIVE but rejects edits and re-activation on ARCHIVED', async () => {
    const harness = buildHarness();
    const profile = await harness.service.createProfile(TENANT, {
      cameraSourceId: 'cam-1',
      name: 'v1',
    });
    const updated = await harness.service.updateProfile(TENANT, profile.id, {
      name: 'v1 adjusted',
      frameWidth: 1920,
      frameHeight: 1080,
      orientation: 'LANDSCAPE' as never,
      cameraMount: 'OVERHEAD' as never,
    });
    expect(updated.name).toBe('v1 adjusted');
    expect(updated.frameWidth).toBe(1920);

    const archived = await harness.service.archiveProfile(TENANT, profile.id);
    expect(archived.status).toBe('ARCHIVED');
    expect(archived.archivedAt).not.toBeNull();
    await expect(
      harness.service.updateProfile(TENANT, profile.id, { name: 'nope' }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      harness.service.activateProfile(TENANT, profile.id),
    ).rejects.toThrow(BadRequestException);
    await expect(
      harness.service.archiveProfile(TENANT, profile.id),
    ).rejects.toThrow(BadRequestException);
  });

  it('activation requires an active SHELF_ZONE and INTERACTION_ZONE', async () => {
    const harness = buildHarness();
    const profile = await harness.service.createProfile(TENANT, {
      cameraSourceId: 'cam-1',
      name: 'incomplete',
    });
    await expect(
      harness.service.activateProfile(TENANT, profile.id),
    ).rejects.toThrow(BadRequestException);

    await harness.service.addZone(TENANT, profile.id, {
      zoneType: 'SHELF_ZONE' as never,
      label: 'shelf',
      polygon: SQUARE,
    } as never);
    // Shelf alone is not enough.
    await expect(
      harness.service.activateProfile(TENANT, profile.id),
    ).rejects.toThrow(BadRequestException);

    // An INACTIVE interaction zone does not count.
    const inactive = await harness.service.addZone(TENANT, profile.id, {
      zoneType: 'INTERACTION_ZONE' as never,
      label: 'reach',
      polygon: SQUARE,
      isActive: false,
    } as never);
    await expect(
      harness.service.activateProfile(TENANT, profile.id),
    ).rejects.toThrow(BadRequestException);

    await harness.service.updateZone(TENANT, profile.id, inactive.id, {
      isActive: true,
    } as never);
    const activated = await harness.service.activateProfile(
      TENANT,
      profile.id,
    );
    expect(activated.status).toBe('ACTIVE');
    expect(activated.activatedAt).not.toBeNull();
  });

  it('keeps at most ONE ACTIVE profile per camera source: activating a second archives the first', async () => {
    const harness = buildHarness();
    const first = await seedActivatedProfile(harness);
    expect(first.status).toBe('ACTIVE');

    const second = await harness.service.createProfile(TENANT, {
      cameraSourceId: 'cam-1',
      name: 'better angles',
    });
    await harness.service.addZone(TENANT, second.id, {
      zoneType: 'SHELF_ZONE' as never,
      label: 'shelf v2',
      polygon: SQUARE,
    } as never);
    await harness.service.addZone(TENANT, second.id, {
      zoneType: 'INTERACTION_ZONE' as never,
      label: 'reach v2',
      polygon: SQUARE,
    } as never);
    const promoted = await harness.service.activateProfile(TENANT, second.id);
    expect(promoted.status).toBe('ACTIVE');

    const previous = await harness.service.profileById(TENANT, first.id);
    expect(previous.status).toBe('ARCHIVED');
    expect(previous.archivedAt).not.toBeNull();
    const active = harness.profiles.filter((row) => row.status === 'ACTIVE');
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(second.id);
  });
});

describe('CameraCalibrationService — zones', () => {
  it('creates, updates, and deletes zones with snapshot SKUs and replace-all product semantics', async () => {
    const harness = buildHarness();
    const profile = await harness.service.createProfile(TENANT, {
      cameraSourceId: 'cam-1',
      name: 'zones',
    });
    const zone = await harness.service.addZone(TENANT, profile.id, {
      zoneType: 'SHELF_ZONE' as never,
      label: 'top shelf',
      polygon: SQUARE,
      qualityScore: 0.8,
      sortOrder: 2,
      expectedProductIds: ['prod-1', 'prod-2'],
    } as never);
    expect(zone.expectedProducts).toEqual([
      { productId: 'prod-1', sku: 'SKU-WATER' },
      { productId: 'prod-2', sku: 'SKU-JUICE' },
    ]);
    expect(zone.polygon).toEqual(SQUARE);

    const updated = await harness.service.updateZone(
      TENANT,
      profile.id,
      zone.id,
      {
        label: 'top shelf drinks',
        expectedProductIds: ['prod-2'],
      } as never,
    );
    expect(updated.label).toBe('top shelf drinks');
    expect(updated.expectedProducts).toEqual([
      { productId: 'prod-2', sku: 'SKU-JUICE' },
    ]);
    expect(
      harness.zoneProducts.filter((row) => row.zoneId === zone.id),
    ).toHaveLength(1);

    const removed = await harness.service.deleteZone(
      TENANT,
      profile.id,
      zone.id,
    );
    expect(removed).toEqual({ id: zone.id, deleted: true });
    expect(harness.zones).toHaveLength(0);
    expect(harness.zoneProducts).toHaveLength(0);
  });

  it('rejects malformed polygons through the write path', async () => {
    const harness = buildHarness();
    const profile = await harness.service.createProfile(TENANT, {
      cameraSourceId: 'cam-1',
      name: 'geometry',
    });
    await expect(
      harness.service.addZone(TENANT, profile.id, {
        zoneType: 'SHELF_ZONE' as never,
        label: 'bad',
        polygon: [{ x: 0.5, y: 0.5 }],
      } as never),
    ).rejects.toThrow(BadRequestException);
    await expect(
      harness.service.addZone(TENANT, profile.id, {
        zoneType: 'SHELF_ZONE' as never,
        label: 'bad',
        polygon: [{ x: 2, y: 0.5 }, { x: 0.1, y: 0.1 }, { x: 0.2, y: 0.9 }],
      } as never),
    ).rejects.toThrow(BadRequestException);
    expect(harness.zones).toHaveLength(0);
  });

  it('allows expected products on SHELF_ZONE only, tenant-scoped, capped', async () => {
    const harness = buildHarness();
    const profile = await harness.service.createProfile(TENANT, {
      cameraSourceId: 'cam-1',
      name: 'products',
    });
    await expect(
      harness.service.addZone(TENANT, profile.id, {
        zoneType: 'INTERACTION_ZONE' as never,
        label: 'reach',
        polygon: SQUARE,
        expectedProductIds: ['prod-1'],
      } as never),
    ).rejects.toThrow(BadRequestException);
    // Foreign-tenant product id: NotFound, nothing persisted.
    await expect(
      harness.service.addZone(TENANT, profile.id, {
        zoneType: 'SHELF_ZONE' as never,
        label: 'shelf',
        polygon: SQUARE,
        expectedProductIds: ['prod-foreign'],
      } as never),
    ).rejects.toThrow(NotFoundException);
    expect(harness.zones).toHaveLength(0);
    expect(harness.zoneProducts).toHaveLength(0);
  });

  it('caps zones per profile and rejects zone writes on ARCHIVED profiles', async () => {
    const harness = buildHarness();
    const profile = await harness.service.createProfile(TENANT, {
      cameraSourceId: 'cam-1',
      name: 'cap',
    });
    for (let index = 0; index < MAX_ZONES_PER_PROFILE; index += 1) {
      harness.zones.push({
        id: `seed-${index}`,
        tenantId: TENANT,
        calibrationProfileId: profile.id,
        cameraSourceId: 'cam-1',
        zoneType: 'IGNORE_ZONE',
        label: `seed ${index}`,
        polygon: SQUARE,
        qualityScore: null,
        isActive: true,
        sortOrder: index,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
    await expect(
      harness.service.addZone(TENANT, profile.id, {
        zoneType: 'SHELF_ZONE' as never,
        label: 'one too many',
        polygon: SQUARE,
      } as never),
    ).rejects.toThrow(BadRequestException);

    await harness.service.archiveProfile(TENANT, profile.id);
    await expect(
      harness.service.updateZone(TENANT, profile.id, 'seed-0', {
        label: 'frozen',
      } as never),
    ).rejects.toThrow(BadRequestException);
    await expect(
      harness.service.deleteZone(TENANT, profile.id, 'seed-0'),
    ).rejects.toThrow(BadRequestException);
  });

  it('screens zone labels for URL/path text', async () => {
    const harness = buildHarness();
    const profile = await harness.service.createProfile(TENANT, {
      cameraSourceId: 'cam-1',
      name: 'labels',
    });
    await expect(
      harness.service.addZone(TENANT, profile.id, {
        zoneType: 'SHELF_ZONE' as never,
        label: assemble('clip', '.m', 'p4'),
        polygon: SQUARE,
      } as never),
    ).rejects.toThrow(BadRequestException);
    expect(harness.zones).toHaveLength(0);
  });
});

describe('CameraCalibrationService — calibration readiness', () => {
  it('a missing camera source is NotFound; a foreign tenant cannot read readiness', async () => {
    const harness = buildHarness();
    await expect(
      harness.service.calibrationReadiness(TENANT, 'cam-x'),
    ).rejects.toThrow(NotFoundException);
    await expect(
      harness.service.calibrationReadiness(OTHER_TENANT, 'cam-1'),
    ).rejects.toThrow(NotFoundException);
  });

  it('NOT_READY with NO_ACTIVE_CALIBRATION_PROFILE when no profile is active', async () => {
    const harness = buildHarness();
    const readiness = await harness.service.calibrationReadiness(
      TENANT,
      'cam-1',
    );
    expect(readiness.readiness).toBe('NOT_READY');
    expect(readiness.hasActiveCalibrationProfile).toBe(false);
    expect(readiness.activeProfileId).toBeNull();
    expect(readiness.profileStatus).toBeNull();
    expect(readiness.warnings).toEqual(['NO_ACTIVE_CALIBRATION_PROFILE']);
  });

  it('warns for missing shelf/interaction zones (NOT_READY) once a profile is active', async () => {
    const harness = buildHarness();
    // Activate legitimately, then deactivate both zones directly.
    const profile = await seedActivatedProfile(harness);
    for (const zone of harness.zones) {
      zone.isActive = false;
    }
    const readiness = await harness.service.calibrationReadiness(
      TENANT,
      'cam-1',
    );
    expect(readiness.readiness).toBe('NOT_READY');
    expect(readiness.warnings).toContain('NO_SHELF_ZONE');
    expect(readiness.warnings).toContain('NO_INTERACTION_ZONE');
    expect(readiness.activeProfileId).toBe(profile.id);
    expect(readiness.zoneCount).toBe(0);
  });

  it('READY with zero warnings at minimum data; WARNING when soft fields are missing', async () => {
    const ready = buildHarness();
    await seedActivatedProfile(ready);
    const readiness = await ready.service.calibrationReadiness(
      TENANT,
      'cam-1',
    );
    expect(readiness).toMatchObject({
      readiness: 'READY',
      warnings: [],
      applicable: true,
      hasActiveCalibrationProfile: true,
      profileStatus: 'ACTIVE',
      hasShelfZone: true,
      hasInteractionZone: true,
      hasIgnoreZone: false,
      hasExpectedProducts: true,
      frameDimensionsKnown: true,
      orientationKnown: true,
      cameraMountKnown: true,
      zoneCount: 2,
      expectedProductCount: 1,
    });
    const raw = JSON.stringify(readiness);
    for (const needle of LEAK_NEEDLES) {
      expect(raw).not.toContain(needle);
    }

    const soft = buildHarness();
    await seedActivatedProfile(soft, {
      expectedProducts: false,
      mountKnown: false,
      frameKnown: false,
      orientationKnown: false,
    });
    const warned = await soft.service.calibrationReadiness(TENANT, 'cam-1');
    expect(warned.readiness).toBe('WARNING');
    expect(warned.warnings).toEqual([
      'NO_EXPECTED_PRODUCTS',
      'FRAME_DIMENSIONS_UNKNOWN',
      'ORIENTATION_UNKNOWN',
      'CAMERA_MOUNT_UNKNOWN',
    ]);
  });

  it('a non-ACTIVE source is NOT_READY; an active live session is a WARNING only', async () => {
    const disabled = buildHarness({
      sources: [
        {
          id: 'cam-1',
          tenantId: TENANT,
          locationId: 'store-1',
          status: 'DISABLED',
          sourceType: 'RTSP_SHADOW',
        },
      ],
    });
    await seedActivatedProfile(disabled);
    const blocked = await disabled.service.calibrationReadiness(
      TENANT,
      'cam-1',
    );
    expect(blocked.readiness).toBe('NOT_READY');
    expect(blocked.warnings).toContain('SOURCE_NOT_ACTIVE');

    const busy = buildHarness();
    await seedActivatedProfile(busy);
    busy.sessions.push({
      id: 'live-1',
      tenantId: TENANT,
      cameraSourceId: 'cam-1',
      status: 'RUNNING',
      createdAt: new Date(),
    });
    const warned = await busy.service.calibrationReadiness(TENANT, 'cam-1');
    expect(warned.readiness).toBe('WARNING');
    expect(warned.warnings).toEqual(['LIVE_SESSION_ALREADY_ACTIVE']);
  });
});

describe('CameraCalibrationService — credential-slot text screening (Codex P1)', () => {
  // Runtime-assembled reserved identifiers — never literals in source.
  const secretSlot = assemble('CAMERA_SECRET', '_SLOT_', 'ALPHA');
  const rtspSlot = assemble('CAMERA_RT', 'SP_SOURCE_', 'ALPHA');

  it('rejects reserved slot identifiers in profile name and notes without echoing the value', async () => {
    const harness = buildHarness();
    for (const input of [
      { cameraSourceId: 'cam-1', name: secretSlot },
      { cameraSourceId: 'cam-1', name: 'ok name', notes: `uses ${secretSlot}` },
      { cameraSourceId: 'cam-1', name: 'ok name', notes: rtspSlot },
      {
        cameraSourceId: 'cam-1',
        name: 'ok name',
        notes: assemble('MY_', 'CREDENTIAL', '_SLOT_9'),
      },
    ]) {
      const error: unknown = await harness.service
        .createProfile(TENANT, input as never)
        .then(() => null)
        .catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(BadRequestException);
      const message = String((error as BadRequestException).message);
      expect(message).not.toContain(secretSlot);
      expect(message).not.toContain(rtspSlot);
      expect(message).not.toContain('ALPHA');
    }
    expect(harness.profiles).toHaveLength(0);
  });

  it('rejects reserved slot identifiers in zone labels; normal labels still pass', async () => {
    const harness = buildHarness();
    const profile = await harness.service.createProfile(TENANT, {
      cameraSourceId: 'cam-1',
      name: 'labels',
    });
    const error: unknown = await harness.service
      .addZone(TENANT, profile.id, {
        zoneType: 'SHELF_ZONE' as never,
        label: `shelf ${secretSlot}`,
        polygon: SQUARE,
      } as never)
      .then(() => null)
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(BadRequestException);
    expect(String((error as BadRequestException).message)).not.toContain(
      secretSlot,
    );
    expect(harness.zones).toHaveLength(0);

    const zone = await harness.service.addZone(TENANT, profile.id, {
      zoneType: 'SHELF_ZONE' as never,
      label: 'Front shelf zone A',
      polygon: SQUARE,
    } as never);
    expect(zone.label).toBe('Front shelf zone A');
  });
});

describe('CameraCalibrationService — FILE_REPLAY exemption (Codex P1)', () => {
  const fileReplaySource = {
    id: 'cam-1',
    tenantId: TENANT,
    locationId: 'store-1',
    status: 'ACTIVE',
    sourceType: 'FILE_REPLAY',
  };

  it('FILE_REPLAY readiness is NOT_APPLICABLE with no warnings — never NOT_READY for missing calibration', async () => {
    const harness = buildHarness({ sources: [{ ...fileReplaySource }] });
    const readiness = await harness.service.calibrationReadiness(
      TENANT,
      'cam-1',
    );
    expect(readiness.applicable).toBe(false);
    expect(readiness.readiness).toBe('NOT_APPLICABLE');
    expect(readiness.warnings).toEqual([]);
    // Factual fields still report reality.
    expect(readiness.hasActiveCalibrationProfile).toBe(false);
    expect(readiness.activeProfileId).toBeNull();
  });

  it('FILE_REPLAY hardening report never prompts calibration actions', async () => {
    const harness = buildHarness({ sources: [{ ...fileReplaySource }] });
    const report = await harness.service.pilotHardeningReport(
      TENANT,
      'cam-1',
    );
    expect(report.calibrationReadiness.readiness).toBe('NOT_APPLICABLE');
    // Calibration is exempt and the source is ACTIVE with no protocol
    // yet — the ONLY suggestion is the Phase 16 flow itself.
    expect(report.recommendedNextActions).toEqual([
      'RUN_PHASE16_TEST_PROTOCOL',
    ]);
  });

  it('RTSP_SHADOW without an active profile stays NOT_READY (gating unchanged)', async () => {
    const harness = buildHarness();
    const readiness = await harness.service.calibrationReadiness(
      TENANT,
      'cam-1',
    );
    expect(readiness.applicable).toBe(true);
    expect(readiness.readiness).toBe('NOT_READY');
    expect(readiness.warnings).toEqual(['NO_ACTIVE_CALIBRATION_PROFILE']);
  });
});

describe('CameraCalibrationService — pilot hardening report', () => {
  it('with nothing configured: CREATE_CALIBRATION_PROFILE, null summaries, structural safety zeros', async () => {
    const harness = buildHarness();
    const report = await harness.service.pilotHardeningReport(
      TENANT,
      'cam-1',
    );
    expect(report.calibrationReadiness.readiness).toBe('NOT_READY');
    expect(report.activeCalibrationProfile).toBeNull();
    expect(report.latestLiveSessionSummary).toBeNull();
    expect(report.latestPerformanceSummary).toBeNull();
    expect(report.recommendedNextActions).toEqual([
      'CREATE_CALIBRATION_PROFILE',
    ]);
    expect(report.zoneSummary).toEqual({
      total: 0,
      shelfZones: 0,
      interactionZones: 0,
      ignoreZones: 0,
      entryExitZones: 0,
    });
    expect(report.expectedProductsSummary).toEqual({
      shelfZonesWithProducts: 0,
      productCount: 0,
    });
    expect(report.safety).toMatchObject({
      orders: 0,
      checkoutSessions: 0,
      paymentIntents: 0,
      paymentEvents: 0,
      inventoryMovements: 0,
      basis: 'SHADOW_MODE_STATIC_GUARD',
    });
    const raw = JSON.stringify(report);
    expect(raw).not.toContain('tenantId');
    for (const needle of LEAK_NEEDLES) {
      expect(raw).not.toContain(needle);
    }
  });

  it('READY source with no protocol recommends RUN_PHASE16_TEST_PROTOCOL; every action stays in the controlled enum', async () => {
    const harness = buildHarness();
    await seedActivatedProfile(harness);
    const report = await harness.service.pilotHardeningReport(
      TENANT,
      'cam-1',
    );
    expect(report.calibrationReadiness.readiness).toBe('READY');
    expect(report.recommendedNextActions).toEqual([
      'RUN_PHASE16_TEST_PROTOCOL',
    ]);
    expect(report.activeCalibrationProfile).not.toBeNull();
    expect(report.zoneSummary.shelfZones).toBe(1);
    expect(report.zoneSummary.interactionZones).toBe(1);
    expect(report.expectedProductsSummary).toEqual({
      shelfZonesWithProducts: 1,
      productCount: 1,
    });
    for (const action of report.recommendedNextActions) {
      expect(PILOT_NEXT_ACTIONS).toContain(action);
    }
  });

  it('a disabled source with a complete profile recommends ENABLE_CAMERA_SOURCE first and stays NOT_READY (Codex P1)', async () => {
    const harness = buildHarness({
      sources: [
        {
          id: 'cam-1',
          tenantId: TENANT,
          locationId: 'store-1',
          status: 'DISABLED',
          sourceType: 'RTSP_SHADOW',
        },
      ],
    });
    await seedActivatedProfile(harness);
    const report = await harness.service.pilotHardeningReport(
      TENANT,
      'cam-1',
    );
    expect(report.sourceStatus).toBe('DISABLED');
    expect(report.calibrationReadiness.readiness).toBe('NOT_READY');
    expect(report.calibrationReadiness.warnings).toContain(
      'SOURCE_NOT_ACTIVE',
    );
    // The recommendation list is NEVER empty while the source is off —
    // an empty list must not read as "ready".
    expect(report.recommendedNextActions).toEqual(['ENABLE_CAMERA_SOURCE']);
    for (const action of report.recommendedNextActions) {
      expect(PILOT_NEXT_ACTIONS).toContain(action);
    }
  });

  it('surfaces session/performance summaries, review backlog, low-quality zones, and dataset export honestly', async () => {
    const harness = buildHarness();
    const profile = await seedActivatedProfile(harness);
    // A low-quality active zone on the ACTIVE profile.
    await harness.service.addZone(TENANT, profile.id, {
      zoneType: 'IGNORE_ZONE' as never,
      label: 'glare corner',
      polygon: SQUARE,
      qualityScore: 0.2,
    } as never);
    harness.sessions.push({
      id: 'live-9',
      tenantId: TENANT,
      cameraSourceId: 'cam-1',
      status: 'STOPPED',
      startedAt: new Date('2026-08-19T09:00:00.000Z'),
      stoppedAt: new Date('2026-08-19T09:05:00.000Z'),
      framesSampled: 42,
      eventWindowsDetected: 3,
      reviewNeeded: 2,
      decision: 'REVIEW_REQUIRED_SHADOW',
      performance: {
        fastMode: true,
        stages: {
          fusion: { count: 3, avgMs: 5, p50Ms: 5, p95Ms: 9, maxMs: 12 },
          sample: { count: 42, avgMs: 30, p50Ms: 28, p95Ms: 55, maxMs: 80 },
        },
      },
      createdAt: new Date('2026-08-19T09:00:00.000Z'),
    });
    harness.protocols.push({
      id: 'proto-1',
      tenantId: TENANT,
      cameraSourceId: 'cam-1',
      status: 'COMPLETED',
      evaluationRunId: 'run-1',
      createdAt: new Date(),
    });
    const report = await harness.service.pilotHardeningReport(
      TENANT,
      'cam-1',
    );
    expect(report.latestLiveSessionSummary).toMatchObject({
      id: 'live-9',
      status: 'STOPPED',
      framesSampled: 42,
      reviewNeeded: 2,
    });
    expect(report.latestPerformanceSummary).toEqual({
      fastMode: true,
      slowestStage: { stage: 'sample', p95Ms: 55, maxMs: 80 },
    });
    // Low quality → physical fixes; backlog → review; completed
    // protocol with a linked run → export. A protocol already exists,
    // so RUN_PHASE16_TEST_PROTOCOL is NOT repeated.
    expect(report.recommendedNextActions).toEqual([
      'CHECK_LIGHTING',
      'REDUCE_OCCLUSION',
      'REVIEW_MISSED_EVENTS',
      'EXPORT_REVIEWED_DATASET',
    ]);
    const raw = JSON.stringify(report);
    for (const needle of LEAK_NEEDLES) {
      expect(raw).not.toContain(needle);
    }
  });

  it('tenant isolation: a foreign tenant gets NotFound, never a report', async () => {
    const harness = buildHarness();
    await expect(
      harness.service.pilotHardeningReport(OTHER_TENANT, 'cam-1'),
    ).rejects.toThrow(NotFoundException);
  });
});
