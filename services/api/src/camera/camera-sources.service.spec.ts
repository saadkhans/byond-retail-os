import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CameraSourceStatus, CameraSourceType } from '@prisma/client';
import {
  CAMERA_CREDENTIAL_SLOTS,
  CameraSourcesService,
  connectionNoteViolation,
  toCameraSourceView,
  validateCredentialRef,
} from './camera-sources.service';
import { CreateCameraSourceDto } from './dto/create-camera-source.dto';

const TENANT = 'tenant-1';

/** Risky-SHAPED fixtures (URLs with credentials, PAN-like digit runs,
 *  key/JWT/entropy shapes) are assembled at RUNTIME from short harmless
 *  pieces so no secret- or URL-shaped literal ever appears in this
 *  source file — gitleaks stays quiet without ignores. */
const assemble = (...parts: string[]) => parts.join('');

function sourceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cam-1',
    tenantId: TENANT,
    locationId: 'store-1',
    unitId: null,
    name: 'Fridge cam',
    shelfZone: null,
    sourceType: CameraSourceType.FILE_REPLAY,
    status: CameraSourceStatus.ACTIVE,
    connectionNote: null,
    credentialRef: 'CAMERA_SECRET_SLOT_TEST',
    replayVideoAssetId: null,
    lastError: null,
    createdById: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function buildService(overrides: {
  location?: { id: string } | null;
  unit?: { id: string } | null;
  asset?: { id: string } | null;
  existing?: Record<string, unknown> | null;
} = {}) {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const prisma: any = {
    location: {
      findFirst: jest.fn(async () =>
        overrides.location === undefined ? { id: 'store-1' } : overrides.location,
      ),
    },
    retailUnit: {
      findFirst: jest.fn(async () =>
        overrides.unit === undefined ? { id: 'unit-1' } : overrides.unit,
      ),
    },
    videoAsset: {
      findFirst: jest.fn(async () =>
        overrides.asset === undefined ? { id: 'asset-1' } : overrides.asset,
      ),
    },
    cameraSource: {
      create: jest.fn(async (args: { data: Record<string, unknown> }) =>
        sourceRow(args.data),
      ),
      findFirst: jest.fn(async () =>
        overrides.existing === undefined ? sourceRow() : overrides.existing,
      ),
      findMany: jest.fn(async () => [sourceRow()]),
      update: jest.fn(async (args: { data: Record<string, unknown> }) =>
        sourceRow(args.data),
      ),
    },
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */
  return { service: new CameraSourcesService(prisma as never), prisma };
}

const CREATE: CreateCameraSourceDto = {
  locationId: 'store-1',
  name: 'Fridge cam',
  sourceType: CameraSourceType.FILE_REPLAY,
};

describe('CameraSourcesService — tenant isolation', () => {
  it('resolves the store within the tenant before writing', async () => {
    const { service, prisma } = buildService();
    await service.create(TENANT, CREATE, 'user-1');
    expect(prisma.location.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: TENANT, id: 'store-1' }),
      }),
    );
  });

  it("rejects another tenant's replay asset (tenant-scoped resolution)", async () => {
    const { service } = buildService({ asset: null });
    await expect(
      service.create(
        TENANT,
        { ...CREATE, replayVideoAssetId: 'foreign-asset' },
        'user-1',
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects a unit outside the store', async () => {
    const { service } = buildService({ unit: null });
    await expect(
      service.create(TENANT, { ...CREATE, unitId: 'foreign-unit' }, 'user-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('list and byId queries carry the tenant predicate', async () => {
    const { service, prisma } = buildService();
    await service.list(TENANT);
    expect(prisma.cameraSource.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: TENANT } }),
    );
    await service.byId(TENANT, 'cam-1');
    expect(prisma.cameraSource.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: TENANT, id: 'cam-1' },
      }),
    );
  });

  it('update addresses the row by the composite (id, tenantId) key', async () => {
    const { service, prisma } = buildService();
    await service.update(TENANT, 'cam-1', { name: 'Renamed' });
    expect(prisma.cameraSource.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id_tenantId: { id: 'cam-1', tenantId: TENANT } },
      }),
    );
  });
});

describe('CameraSourcesService — no secrets, no URLs', () => {
  it('rejects a credential-bearing connectionNote (reject-on-write)', async () => {
    const { service } = buildService();
    await expect(
      service.create(
        TENANT,
        {
          ...CREATE,
          connectionNote: assemble(
            'rtsp:/',
            '/admin:',
            'hun',
            'ter2@',
            '10.0.0.5/stream',
          ),
        },
        'user-1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('REDACTS credentialRef from every view — only hasCredentialRef survives', () => {
    const view = toCameraSourceView(sourceRow() as never);
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain('credentialRef"');
    expect(serialized).not.toContain('CAMERA_SECRET_SLOT_TEST');
    expect(view.hasCredentialRef).toBe(true);
    expect(
      toCameraSourceView(sourceRow({ credentialRef: null }) as never)
        .hasCredentialRef,
    ).toBe(false);
  });
});

describe('validateCredentialRef — only reserved slot names, never secrets', () => {
  it.each([...CAMERA_CREDENTIAL_SLOTS])(
    'accepts the server-recognized slot %s',
    (slot) => {
      expect(validateCredentialRef(slot)).toBeNull();
    },
  );

  it.each([
    ['password-like', assemble('hun', 'ter2!', 'Win', 'ter', '2026')],
    ['PAN-like', assemble('4111', '1111', '1111', '1111')],
    [
      'PAN smuggled into the namespace',
      assemble('CAMERA_SECRET_SLOT_', '4111', '1111', '1111', '1111'),
    ],
    [
      'PAN split by slot-name underscores',
      ['CAMERA_SECRET_SLOT', '4111', '1111', '1111', '1111'].join('_'),
    ],
    [
      'a second separator-split card shape',
      ['CAMERA_SECRET_SLOT', '1234', '5678', '9012', '3456'].join('_'),
    ],
    [
      'mostly-numeric slot suffix (account fragment in costume)',
      assemble('CAMERA_SECRET_SLOT_', 'A', '12345678'),
    ],
    [
      'reserved suffix word PASSWORD',
      assemble('CAMERA_SECRET_SLOT_', 'PASS', 'WORD'),
    ],
    ['reserved suffix word TOKEN', assemble('CAMERA_SECRET_SLOT_', 'TO', 'KEN')],
    [
      'API-key-like',
      assemble('sk_', 'live_', 'a1b2', 'c3d4', 'e5f6', 'g7h8'),
    ],
    [
      'JWT-like',
      assemble('ey', 'JhbGciOi', '.', 'ey', 'JzdWIiOi', '.', 'c2ln', 'bmF0dXJl'),
    ],
    ['URL with credentials', assemble('rtsp:/', '/cam:pw@', 'host/live')],
    ['connection string', assemble('postgres:/', '/u:p@', 'h/db')],
    [
      'high-entropy-looking value',
      assemble('Zx9', 'Qk4', 'Tv7', 'Wm2').repeat(3),
    ],
    ['lowercase identifier outside the namespace', 'fridge-cam-slot-1'],
  ])('rejects a %s value', (_label, value) => {
    expect(validateCredentialRef(value)).not.toBeNull();
  });

  it('ALLOWLIST semantics, not shape (Codex P1): benign-looking but non-recognized slots are rejected', () => {
    // A letter-separated PAN would pass every shape heuristic — the
    // allowlist is the fix, so even harmless-looking strangers reject.
    expect(validateCredentialRef('CAMERA_SECRET_SLOT_SHELF')).not.toBeNull();
    expect(
      validateCredentialRef('CAMERA_SECRET_SLOT_FRIDGE_12'),
    ).not.toBeNull();
  });

  it('rejects a PAN split by allowed slot LETTERS (Codex P1 fixture)', () => {
    expect(
      validateCredentialRef(
        assemble(
          'CAMERA_SECRET_SLOT_',
          'ABCD4111',
          'EFGH1111',
          'IJKL1111',
          'MNOP1111',
        ),
      ),
    ).not.toBeNull();
  });

  it('rejects a password-word suffix (Codex P1 fixture)', () => {
    expect(
      validateCredentialRef(assemble('CAMERA_SECRET_SLOT_', 'HUNTER', '2')),
    ).not.toBeNull();
  });

  it('the service refuses to persist a rejected credentialRef', async () => {
    const { service, prisma } = buildService();
    await expect(
      service.create(
        TENANT,
        { ...CREATE, credentialRef: assemble('4111', '1111', '1111', '1111') },
        'user-1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.update(TENANT, 'cam-1', {
        credentialRef: assemble('sk_', 'live_', 'abc', '123', 'def'),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.cameraSource.create).not.toHaveBeenCalled();
    expect(prisma.cameraSource.update).not.toHaveBeenCalled();
  });
});

describe('connectionNoteViolation — free text only, no URLs or addresses', () => {
  it.each([
    [
      'credential-free RTSP URL',
      assemble('rtsp:/', '/camera.internal/live'),
    ],
    ['secure-RTSP scheme', assemble('rtsps:/', '/cam.local/live')],
    ['https URL', assemble('https:/', '/example.com')],
    ['mqtt scheme', assemble('mqtt:/', '/broker.local')],
    ['tcp scheme', assemble('tcp:/', '/1.2.3.4:554')],
    ['udp scheme', assemble('udp:/', '/1.2.3.4:5000')],
    ['file scheme', assemble('file:/', '/mnt/cam')],
    ['redis scheme', assemble('redis:/', '/cache.local')],
    ['mysql scheme', assemble('mysql:/', '/db.local/cams')],
    ['bare internal hostname', 'camera.internal'],
    ['multi-label hostname', 'cam-3.store.local'],
    ['scheme-colon form', 'rtsp:cam3'],
    ['connection key=value', 'host=10.0.0.5 user=cam'],
    ['bare IPv4 address', 'feed at 10.0.0.5 please'],
    // Codex P1 round 3 — scheme-relative and IPv6 endpoints (assembled at
    // runtime so no address-shaped literal lives in this file).
    [
      'scheme-relative URL with bracketed IPv6 and port',
      assemble('//', '[fd00::1]', ':554/live'),
    ],
    ['scheme-relative URL', assemble('//', 'cam-host/stream')],
    ['bracketed IPv6 with port', assemble('[', 'fd00::1', ']', ':554')],
    ['bracketed IPv6 without port', assemble('[', '2001:db8::7', ']')],
    ['bare IPv6 literal', assemble('fd00:', ':1')],
    ['bare loopback IPv6', assemble(':', ':1')],
    ['link-local IPv6 with zone', assemble('fe80:', ':1', '%eth0')],
    [
      'full-form IPv6 with hex groups',
      assemble('2001:db8:85a3', ':0:0:8a2e', ':370:7334'),
    ],
    // Codex P1 round 4 — scheme-relative after punctuation/separators, and
    // ALL-NUMERIC full-form IPv6 (no "::", no hex letters) that only a
    // real address parser recognizes.
    [
      'scheme-relative URL after an equals sign',
      assemble('endpoint=', '//', 'camera/live'),
    ],
    [
      'scheme-relative URL inside parentheses',
      assemble('endpoint=(', '//', 'camera/live', ')'),
    ],
    [
      'scheme-relative URL inside brackets',
      assemble('see [', '//', 'camera/live', ']'),
    ],
    ['bare scheme-relative URL', assemble('//', 'camera/live')],
    [
      'all-numeric full-form IPv6',
      assemble('2001:0:0:0', ':0:0:0:1'),
    ],
    [
      'bracketed all-numeric full-form IPv6',
      assemble('[', '2001:0:0:0', ':0:0:0:1', ']'),
    ],
    [
      'bracketed all-numeric full-form IPv6 with port',
      assemble('[', '2001:0:0:0', ':0:0:0:1', ']', ':554'),
    ],
    [
      'all-numeric full-form IPv6 after an equals sign',
      assemble('endpoint=', '2001:0:0:0', ':0:0:0:1'),
    ],
    // Codex P1 final round — the comprehensive matrix: scheme-relative
    // after EVERY separator class, and IPv6 in prose/parenthesized/
    // bracket-with-path positions (assembled at runtime as elsewhere).
    [
      'scheme-relative URL inside braces after a colon',
      assemble('value:{', '//', 'camera/live', '}'),
    ],
    [
      'scheme-relative URL after a comma and quote',
      assemble("note,'", '//', 'camera/live', "'"),
    ],
    [
      'all-numeric full-form IPv6 in prose',
      assemble('camera at ', '2001:0:0:0', ':0:0:0:1'),
    ],
    [
      'all-numeric full-form IPv6 in parentheses',
      assemble('endpoint=(', '2001:0:0:0', ':0:0:0:1', ')'),
    ],
    [
      'compressed IPv6 at a sentence end',
      assemble('reachable on fd00:', ':1', '.'),
    ],
    [
      'bracketed IPv6 with port and path',
      assemble('[', 'fd00::1', ']', ':554/live'),
    ],
    // Codex P1 — IPv6 attached to a prose label with NO whitespace: the
    // label and address share one token, so colon-suffix extraction (not
    // whole-token parsing alone) must find the address.
    [
      'colon-labeled full-form IPv6',
      assemble('endpoint:', '2001:0:0:0', ':0:0:0:1'),
    ],
    [
      'at-sign-labeled full-form IPv6',
      assemble('endpoint@', '2001:0:0:0', ':0:0:0:1'),
    ],
    [
      'parenthesis-attached full-form IPv6',
      assemble('endpoint(', '2001:0:0:0', ':0:0:0:1', ')'),
    ],
    [
      'bracket-attached full-form IPv6',
      assemble('endpoint[', '2001:0:0:0', ':0:0:0:1', ']'),
    ],
    [
      'comma-attached full-form IPv6',
      assemble('endpoint,', '2001:0:0:0', ':0:0:0:1'),
    ],
    [
      'full-form IPv6 at a sentence end',
      assemble('camera at ', '2001:0:0:0', ':0:0:0:1', '.'),
    ],
    ['colon-labeled compressed IPv6', assemble('endpoint:', 'fd00:', ':1')],
    [
      'at-sign-labeled bracketed IPv6 with port',
      assemble('endpoint@', '[', 'fd00::1', ']', ':554'),
    ],
  ])('rejects a %s', (_label, note) => {
    expect(connectionNoteViolation(note)).not.toBeNull();
  });

  it('accepts placeholder prose (no URL, no endpoint)', () => {
    expect(
      connectionNoteViolation('north shelf camera placeholder only'),
    ).toBeNull();
    expect(
      connectionNoteViolation('camera placeholder, credentials stored separately'),
    ).toBeNull();
  });

  it('accepts benign human notes (measurements are not hostnames)', () => {
    expect(connectionNoteViolation('fridge cam, aisle 3, 2.5m height')).toBeNull();
    expect(connectionNoteViolation('mounted above shelf, angle 3.5 degrees')).toBeNull();
    expect(connectionNoteViolation('replaced 2026-08, lens cleaned')).toBeNull();
  });

  it('colon-bearing prose is NOT an IPv6 address: times and ratios stay valid', () => {
    expect(connectionNoteViolation('shift 12:30, aisle 3')).toBeNull();
    expect(connectionNoteViolation('aspect 3:2 crop')).toBeNull();
    expect(connectionNoteViolation('maintenance window 12:30:45 daily')).toBeNull();
  });

  it('accepts placeholder prose with plain colons and ordinary text', () => {
    expect(
      connectionNoteViolation('camera placeholder: north shelf'),
    ).toBeNull();
    expect(connectionNoteViolation('installed near shelf A')).toBeNull();
    expect(
      connectionNoteViolation('edge camera slot assigned by ops'),
    ).toBeNull();
    expect(connectionNoteViolation('note: camera placeholder only')).toBeNull();
    expect(connectionNoteViolation('credentials stored separately')).toBeNull();
  });

  it('the service rejects unsafe notes on create AND update — every class through the ONE helper', async () => {
    const { service } = buildService();
    const unsafe = [
      assemble('rtsp:/', '/camera.internal/live'),
      assemble('endpoint=(', '//', 'camera/live', ')'),
      assemble('endpoint=', '2001:0:0:0', ':0:0:0:1'),
    ];
    for (const connectionNote of unsafe) {
      await expect(
        service.create(TENANT, { ...CREATE, connectionNote }, 'user-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.update(TENANT, 'cam-1', { connectionNote }),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    await expect(
      service.update(TENANT, 'cam-1', { connectionNote: 'camera.internal' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('CameraSourcesService — placeholder source types', () => {
  it('RTSP/webcam placeholders register DISABLED regardless of request', async () => {
    const { service, prisma } = buildService();
    await service.create(
      TENANT,
      { ...CREATE, sourceType: CameraSourceType.RTSP_PLACEHOLDER },
      'user-1',
    );
    expect(prisma.cameraSource.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: CameraSourceStatus.DISABLED,
        }),
      }),
    );
  });

  it('a placeholder can never be activated', async () => {
    const { service } = buildService({
      existing: sourceRow({
        sourceType: CameraSourceType.LOCAL_WEBCAM_PLACEHOLDER,
        status: CameraSourceStatus.DISABLED,
      }),
    });
    await expect(
      service.update(TENANT, 'cam-1', { status: CameraSourceStatus.ACTIVE }),
    ).rejects.toThrow('source type not enabled in shadow pilot');
  });
});
