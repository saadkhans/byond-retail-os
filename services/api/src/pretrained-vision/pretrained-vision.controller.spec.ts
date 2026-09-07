import 'reflect-metadata';
import {
  REQUIRED_MODULE_KEY,
  REQUIRED_PERMISSIONS_KEY,
  TENANT_ONLY_KEY,
} from '../auth/decorators/access-policy.decorators';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import {
  EvaluateClipDto,
  PretrainedVisionController,
  parseRackFrameRegionQuery,
} from './pretrained-vision.module';
import { PretrainedVisionService } from './pretrained-vision.service';

/**
 * Access-policy pin for the Phase 19 pretrained-vision surface:
 * tenant-scoped, cv-module-gated; reads need vision:read and the
 * evaluation write needs vision:review. (The service ADDITIONALLY
 * enforces the video-asset read boundary — video-ingest module +
 * video-asset:read — on evaluate and report.)
 */
describe('PretrainedVisionController access policy', () => {
  it('is tenant-only and gated on the cv module at the class level', () => {
    expect(
      Reflect.getMetadata(TENANT_ONLY_KEY, PretrainedVisionController),
    ).toBe(true);
    expect(
      Reflect.getMetadata(REQUIRED_MODULE_KEY, PretrainedVisionController),
    ).toBe('cv');
  });

  it.each([
    ['providers', ['vision:read']],
    ['report', ['vision:read']],
    ['evaluate', ['vision:review']],
  ] as const)('requires %s permissions', (handler, expected) => {
    expect(
      Reflect.getMetadata(
        REQUIRED_PERMISSIONS_KEY,
        PretrainedVisionController.prototype[handler],
      ),
    ).toEqual(expected);
  });
});

describe('PretrainedVisionController.providers (Codex P1)', () => {
  it('awaits the async status list so the response carries an ARRAY, never a nested promise', async () => {
    const statuses = [
      {
        provider: 'CLASSICAL',
        kind: 'CLASSICAL',
        availability: 'READY',
        reasonCode: null,
        stubMode: false,
        runtime: null,
      },
    ];
    const service = {
      providerStatuses: jest.fn(async () => statuses),
    } as unknown as PretrainedVisionService;
    const controller = new PretrainedVisionController(service);
    const response = await controller.providers();
    expect(Array.isArray(response.providers)).toBe(true);
    expect(response.providers).toEqual(statuses);
    // What Express would serialize: the array, not "{}".
    expect(JSON.parse(JSON.stringify(response))).toEqual({ providers: statuses });
  });
});

describe('EvaluateClipDto.rackFrameRegion (Phase 21)', () => {
  const errorsFor = async (body: Record<string, unknown>) =>
    validate(plainToInstance(EvaluateClipDto, body));

  it('accepts a normalized region with a positive extent', async () => {
    expect(
      await errorsFor({ rackFrameRegion: { x: 0.1, y: 0.2, width: 0.8, height: 0.5 } }),
    ).toHaveLength(0);
  });

  it('is optional', async () => {
    expect(await errorsFor({ rackCode: 'R1' })).toHaveLength(0);
  });

  it.each([
    ['x above 1', { x: 1.2, y: 0, width: 0.5, height: 0.5 }],
    ['negative y', { x: 0, y: -0.1, width: 0.5, height: 0.5 }],
    ['zero width', { x: 0, y: 0, width: 0, height: 0.5 }],
    ['non-numeric height', { x: 0, y: 0, width: 0.5, height: 'tall' }],
    ['missing fields', { x: 0.2 }],
  ])('rejects %s', async (_label, region) => {
    const errors = await errorsFor({ rackFrameRegion: region });
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('parseRackFrameRegionQuery (report query)', () => {
  it('needs all four numbers in 0..1 with a positive extent', () => {
    expect(parseRackFrameRegionQuery({ rx: '0.1', ry: '0.2', rw: '0.8', rh: '0.5' })).toEqual({
      x: 0.1,
      y: 0.2,
      width: 0.8,
      height: 0.5,
    });
    expect(parseRackFrameRegionQuery({ rx: '0.1', ry: '0.2', rw: '0.8' })).toBeNull();
    expect(parseRackFrameRegionQuery({ rx: '0.1', ry: '0.2', rw: '0', rh: '0.5' })).toBeNull();
    expect(parseRackFrameRegionQuery({ rx: '2', ry: '0.2', rw: '0.8', rh: '0.5' })).toBeNull();
    expect(parseRackFrameRegionQuery({})).toBeNull();
  });
});
