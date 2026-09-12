import { describe, expect, it } from 'vitest';
import type { ClipLabReport, Product, VideoAsset } from './api';
import {
  countAgreements,
  DEFAULT_SKU_ALIASES,
  distinctSkuTokens,
  isVideoFilename,
  matchUploadedAssets,
  parseClipFilename,
  previewIsFresh,
  resolveProductForToken,
  sanitizeFilenameLikeServer,
  suggestGroundTruth,
  truthAgreement,
  validateGroundTruthRow,
  type ParsedClipName,
} from './clip-batch-utils';

const product = (sku: string, name: string, id = sku.toLowerCase()): Product => ({
  id,
  sku,
  name,
  status: 'ACTIVE',
  unitOfMeasure: 'EA',
  lowStockThreshold: null,
});

const WATER = product('WATER-BOTTLE-500ML', 'Drinking Water Bottle 500ml', 'p-water');
const NESCAFE = product('SKU-LIME-GREEN', 'Nescafe', 'p-nescafe');
const CATALOG = [WATER, NESCAFE, product('SODA-BLUE-330ML', 'Blue Soda'), product('SKU-SODA-BLUE', 'Soda Blue')];

function parsed(overrides: Partial<ParsedClipName> = {}): ParsedClipName {
  return {
    run: 'r1',
    cell: 'b1',
    skuToken: 'water',
    type: 'pickup',
    light: 'room',
    index: 1,
    extension: '.mp4',
    ...overrides,
  };
}

describe('parseClipFilename', () => {
  it('parses the documented pattern, tolerating case and a folder prefix', () => {
    const result = parseClipFilename('Batch1/R1_A1_Water_Pickup_Room_01.MOV');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.parsed).toEqual({
        run: 'r1',
        cell: 'a1',
        skuToken: 'water',
        type: 'pickup',
        light: 'room',
        index: 1,
        extension: '.mov',
      });
    }
    expect(parseClipFilename('r1_rack_none_nothing_fridge_02.mp4')).toMatchObject({
      ok: true,
      parsed: { cell: 'rack', skuToken: 'none', type: 'nothing', light: 'fridge', index: 2 },
    });
  });

  it.each([
    ['notes.txt', 'NOT_VIDEO'],
    ['r1_a1_water_pickup_01.mp4', 'WRONG_TOKEN_COUNT'],
    ['r1_c3_water_pickup_room_01.mp4', 'UNKNOWN_CELL'],
    ['r1_a1_water_grab_room_01.mp4', 'UNKNOWN_TYPE'],
    ['r1_a1_water_pickup_dark_01.mp4', 'UNKNOWN_LIGHT'],
    ['r1_a1_water_pickup_room_xx.mp4', 'BAD_INDEX'],
  ])('rejects %s with %s', (name, reason) => {
    expect(parseClipFilename(name)).toEqual({ ok: false, reason });
  });

  it('recognises video extensions and the server-style sanitized name', () => {
    expect(isVideoFilename('a.MP4')).toBe(true);
    expect(isVideoFilename('a.webm')).toBe(true);
    expect(isVideoFilename('a.jpg')).toBe(false);
    expect(sanitizeFilenameLikeServer('r1 a1 (x).mp4')).toBe('r1_a1__x_.mp4');
    expect(sanitizeFilenameLikeServer('folder/r1_a1.mp4')).toBe('r1_a1.mp4');
  });
});

describe('suggestGroundTruth', () => {
  it.each([
    ['pickup', 'PICKUP', 'PICKUP_SINGLE', 'water', 1, 'EXACT', 4500],
    ['return', 'RETURN', 'RETURN_SINGLE', 'water', 1, 'EXACT', 4500],
    ['touch', 'NONE', 'FALSE_TOUCH', null, 1, 'EXACT', null],
    ['wrongcell', 'PICKUP', 'PICKUP_SINGLE', 'water', 1, 'APPROXIMATED', 4500],
    ['double', 'PICKUP', 'PICKUP_SINGLE', 'water', 1, 'APPROXIMATED', 4500],
    ['nothing', 'NONE', null, null, 1, 'EXACT', null],
  ] as const)('%s → %s / %s', (type, kind, scenario, token, quantity, confidence, ms) => {
    const suggestion = suggestGroundTruth(parsed({ type }));
    expect(suggestion.eventKind).toBe(kind);
    expect(suggestion.testType).toBe(scenario);
    expect(suggestion.productToken).toBe(token);
    expect(suggestion.quantity).toBe(quantity);
    expect(suggestion.confidence).toBe(confidence);
    expect(suggestion.actualTimestampMs).toBe(ms);
  });

  it('keeps cell, light, type and sku in the note, plus the type-specific suffix', () => {
    expect(suggestGroundTruth(parsed()).note).toBe('cell=b1 light=room type=pickup sku=water');
    expect(suggestGroundTruth(parsed({ type: 'double' })).note).toBe(
      'cell=b1 light=room type=double sku=water double: first take recorded',
    );
    expect(suggestGroundTruth(parsed({ type: 'wrongcell' })).note).toContain('wrongcell');
  });

  it('flags a pickup whose name says no product', () => {
    const suggestion = suggestGroundTruth(parsed({ skuToken: 'none' }));
    expect(suggestion.confidence).toBe('NONE');
    expect(suggestion.productToken).toBeNull();
    expect(suggestion.hint).toMatch(/needs a product/);
  });
});

describe('resolveProductForToken', () => {
  it('resolves through the alias table first, then exact sku, then a single name hit', () => {
    expect(resolveProductForToken('water', CATALOG)).toMatchObject({ status: 'RESOLVED', via: 'ALIAS', product: WATER });
    expect(resolveProductForToken('nescafe', CATALOG)).toMatchObject({ status: 'RESOLVED', via: 'ALIAS', product: NESCAFE });
    expect(resolveProductForToken('SKU-LIME-GREEN', CATALOG, {})).toMatchObject({ status: 'RESOLVED', via: 'SKU' });
    expect(resolveProductForToken('nescafe', CATALOG, {})).toMatchObject({ status: 'RESOLVED', via: 'NAME' });
  });

  it('reports ambiguity, no match, and the none token', () => {
    expect(resolveProductForToken('soda', CATALOG, {})).toMatchObject({ status: 'AMBIGUOUS' });
    expect(resolveProductForToken('juice', CATALOG)).toEqual({ status: 'UNRESOLVED' });
    expect(resolveProductForToken('none', CATALOG)).toEqual({ status: 'NONE' });
    expect(DEFAULT_SKU_ALIASES.water).toBe('WATER-BOTTLE-500ML');
  });

  it('lists distinct sku tokens without none', () => {
    expect(
      distinctSkuTokens([
        parseClipFilename('r1_a1_water_pickup_room_01.mp4'),
        parseClipFilename('r1_a2_nescafe_pickup_room_01.mp4'),
        parseClipFilename('r1_b1_water_touch_room_01.mp4'),
        parseClipFilename('r1_rack_none_nothing_room_01.mp4'),
        parseClipFilename('bad.txt'),
      ]),
    ).toEqual(['water', 'nescafe']);
  });
});

describe('validateGroundTruthRow', () => {
  const base = { eventKind: 'PICKUP' as const, productId: 'p-water', testType: 'PICKUP_SINGLE' as const, actualTimestampMs: 4500, quantity: 1, note: '' };

  it('mirrors the server rules', () => {
    expect(validateGroundTruthRow(base, 10_000)).toBeNull();
    expect(validateGroundTruthRow({ ...base, productId: null }, 10_000)).toMatch(/needs a product/);
    expect(validateGroundTruthRow({ ...base, actualTimestampMs: null }, 10_000)).toMatch(/timestamp/);
    expect(validateGroundTruthRow({ ...base, actualTimestampMs: 12_000 }, 10_000)).toMatch(/clip length/);
    expect(validateGroundTruthRow({ ...base, testType: 'FALSE_TOUCH' }, 10_000)).toMatch(/needs event kind NONE/);
    expect(validateGroundTruthRow({ ...base, quantity: 0 }, 10_000)).toMatch(/quantity/);
    expect(
      validateGroundTruthRow({ eventKind: 'NONE', productId: null, testType: 'FALSE_TOUCH', actualTimestampMs: null, quantity: 1, note: '' }, null),
    ).toBeNull();
  });
});

describe('resume matching and screening freshness', () => {
  const asset = (name: string, status: string, createdAt: string): VideoAsset =>
    ({ id: `${name}-${createdAt}`, originalFilename: name, status, createdAt, deletedAt: null }) as unknown as VideoAsset;

  it('matches sanitized names, ignores rejected uploads, keeps the newest', () => {
    const matched = matchUploadedAssets(
      [{ name: 'r1 a1 (x).mp4' }, { name: 'r1_b1_water_pickup_room_01.mp4' }, { name: 'r1_b2_nescafe_pickup_room_01.mp4' }],
      [
        asset('r1_a1__x_.mp4', 'READY', '2026-09-12T10:00:00Z'),
        asset('r1_b1_water_pickup_room_01.mp4', 'REJECTED', '2026-09-12T10:00:00Z'),
        asset('r1_b2_nescafe_pickup_room_01.mp4', 'QUARANTINED', '2026-09-12T10:00:00Z'),
        asset('r1_b2_nescafe_pickup_room_01.mp4', 'READY', '2026-09-12T11:00:00Z'),
      ],
    );
    expect(matched.get('r1_a1__x_.mp4')?.status).toBe('READY');
    expect(matched.has('r1_b1_water_pickup_room_01.mp4')).toBe(false);
    expect(matched.get('r1_b2_nescafe_pickup_room_01.mp4')?.createdAt).toBe('2026-09-12T11:00:00Z');
  });

  it('treats a preview as fresh for 25 minutes', () => {
    const now = 1_000_000_000;
    expect(previewIsFresh(now - 24 * 60_000, now)).toBe(true);
    expect(previewIsFresh(now - 25 * 60_000, now)).toBe(false);
    expect(previewIsFresh(null, now)).toBe(false);
  });
});

describe('truthAgreement', () => {
  const report = (truth: ClipLabReport['asset']['groundTruth'], suggestion: ClipLabReport['suggestion']) =>
    ({ asset: { groundTruth: truth }, suggestion }) as unknown as ClipLabReport;
  const pickupWater = { eventKind: 'PICKUP', sku: 'WATER-BOTTLE-500ML', actualTimestampMs: 4500 };
  const suggest = (sku: string | null, action: string) => ({ sku, action, reviewRequired: true, notes: [] });

  it('scores match, wrong sku, wrong action, missing pieces', () => {
    expect(truthAgreement(report(pickupWater, suggest('WATER-BOTTLE-500ML', 'PICKUP')))).toBe('MATCH');
    expect(truthAgreement(report(pickupWater, suggest('SKU-LIME-GREEN', 'PICKUP')))).toBe('SKU_MISMATCH');
    expect(truthAgreement(report(pickupWater, suggest('WATER-BOTTLE-500ML', 'RETURN')))).toBe('ACTION_MISMATCH');
    expect(truthAgreement(report(pickupWater, suggest(null, 'UNKNOWN')))).toBe('NO_SUGGESTION');
    expect(truthAgreement(report(null, suggest('WATER-BOTTLE-500ML', 'PICKUP')))).toBe('NO_TRUTH');
    expect(truthAgreement(report({ eventKind: 'NONE', sku: null, actualTimestampMs: null }, suggest(null, 'UNKNOWN')))).toBe('MATCH');
    expect(truthAgreement(report({ eventKind: 'NONE', sku: null, actualTimestampMs: null }, suggest('WATER-BOTTLE-500ML', 'PICKUP')))).toBe('ACTION_MISMATCH');
    expect(countAgreements(['MATCH', 'MATCH', 'NO_TRUTH']).MATCH).toBe(2);
  });
});
