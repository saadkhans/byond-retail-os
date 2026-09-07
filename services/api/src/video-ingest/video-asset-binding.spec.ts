import { BadRequestException } from '@nestjs/common';
import {
  VideoAssetBindingValidator,
  normalizeRackCode,
  parseRackFrameRegion,
  sanitizeStoredRackFrameRegion,
} from './video-asset-binding';

describe('video-asset planogram binding helpers (Phase 22)', () => {
  it('normalizes rack codes to upper case and rejects unsafe shapes', () => {
    expect(normalizeRackCode(undefined)).toBeNull();
    expect(normalizeRackCode('  ')).toBeNull();
    expect(normalizeRackCode('shelf-2x2')).toBe('SHELF-2X2');
    expect(() => normalizeRackCode('../r1')).toThrow(BadRequestException);
    expect(() => normalizeRackCode('a'.repeat(33))).toThrow(BadRequestException);
    expect(() => normalizeRackCode('R1; drop')).toThrow(BadRequestException);
  });

  it('parses a JSON-string region from multipart and an object from JSON bodies', () => {
    expect(parseRackFrameRegion('{"x":0,"y":0.15,"width":1,"height":0.57}')).toEqual({
      x: 0,
      y: 0.15,
      width: 1,
      height: 0.57,
    });
    expect(parseRackFrameRegion({ x: 0.1, y: 0.2, width: 0.5, height: 0.5 })).toEqual({
      x: 0.1,
      y: 0.2,
      width: 0.5,
      height: 0.5,
    });
    expect(parseRackFrameRegion(undefined)).toBeNull();
    expect(parseRackFrameRegion('')).toBeNull();
  });

  it('rejects regions outside the frame, degenerate sizes, and garbage', () => {
    for (const bad of [
      'not json',
      '[1,2,3]',
      '{"x":0.9,"y":0,"width":0.5,"height":0.5}',
      '{"x":0,"y":0,"width":0,"height":0.5}',
      '{"x":"a","y":0,"width":1,"height":1}',
      '{"x":-0.1,"y":0,"width":1,"height":1}',
    ]) {
      expect(() => parseRackFrameRegion(bad)).toThrow(BadRequestException);
    }
    // Stored rows are rebuilt on the way out — a bad row yields null, never a throw.
    expect(sanitizeStoredRackFrameRegion({ x: 5 })).toBeNull();
    expect(sanitizeStoredRackFrameRegion({ x: 0, y: 0, width: 1, height: 1 })).toEqual({
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    });
  });
});

describe('VideoAssetBindingValidator (Phase 22)', () => {
  const rackFindFirst = jest.fn();
  const validator = new VideoAssetBindingValidator({
    planogramRack: { findFirst: rackFindFirst },
  } as never);

  beforeEach(() => rackFindFirst.mockReset());

  it('a rack code requires a store', async () => {
    await expect(
      validator.resolve('tenant-1', { locationId: null, planogramRackCode: 'R1' }),
    ).rejects.toThrow(BadRequestException);
    expect(rackFindFirst).not.toHaveBeenCalled();
  });

  it('a region without a rack is rejected', async () => {
    await expect(
      validator.resolve('tenant-1', {
        locationId: 'store-1',
        planogramRackCode: null,
        rackFrameRegion: '{"x":0,"y":0,"width":1,"height":1}',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('an unknown or inactive rack at that store is a 400 (tenant-scoped lookup)', async () => {
    rackFindFirst.mockResolvedValueOnce(null);
    await expect(
      validator.resolve('tenant-1', { locationId: 'store-1', planogramRackCode: 'r9' }),
    ).rejects.toThrow(BadRequestException);
    expect(rackFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'tenant-1',
          locationId: 'store-1',
          rackCode: 'R9',
          status: 'ACTIVE',
        }),
      }),
    );
  });

  it('resolves an ACTIVE rack with its region', async () => {
    rackFindFirst.mockResolvedValueOnce({ id: 'rack-1' });
    await expect(
      validator.resolve('tenant-1', {
        locationId: 'store-1',
        planogramRackCode: 'shelf-2x2',
        rackFrameRegion: '{"x":0,"y":0.15,"width":1,"height":0.57}',
      }),
    ).resolves.toEqual({
      planogramRackCode: 'SHELF-2X2',
      rackFrameRegion: { x: 0, y: 0.15, width: 1, height: 0.57 },
    });
  });

  it('no rack and no region is a no-op binding', async () => {
    await expect(
      validator.resolve('tenant-1', { locationId: 'store-1', planogramRackCode: null }),
    ).resolves.toEqual({ planogramRackCode: null, rackFrameRegion: null });
    expect(rackFindFirst).not.toHaveBeenCalled();
  });
});
