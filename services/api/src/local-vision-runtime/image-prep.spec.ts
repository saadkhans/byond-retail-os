import {
  LETTERBOX_FILL,
  isWellFormedImage,
  l2Normalize,
  letterboxSquare,
  resizeNearest,
} from './image-prep';

function solid(width: number, height: number, value: number) {
  return { width, height, rgb: Buffer.alloc(width * height * 3, value) };
}

describe('image-prep (embedding input letterbox)', () => {
  it('centres a portrait image inside the square and pads with the neutral grey', () => {
    const out = letterboxSquare(solid(20, 40, 200), 64);
    expect(out.width).toBe(64);
    expect(out.height).toBe(64);
    expect(out.rgb.length).toBe(64 * 64 * 3);
    // Fitted 32x64, centred horizontally: columns 0..15 are fill, 16..47
    // image, 48..63 fill.
    const px = (x: number, y: number) => out.rgb[(y * 64 + x) * 3];
    expect(px(0, 10)).toBe(LETTERBOX_FILL);
    expect(px(15, 10)).toBe(LETTERBOX_FILL);
    expect(px(16, 10)).toBe(200);
    expect(px(47, 10)).toBe(200);
    expect(px(48, 10)).toBe(LETTERBOX_FILL);
  });

  it('centres a landscape image vertically', () => {
    const out = letterboxSquare(solid(40, 20, 90), 64);
    const px = (x: number, y: number) => out.rgb[(y * 64 + x) * 3];
    expect(px(10, 0)).toBe(LETTERBOX_FILL);
    expect(px(10, 15)).toBe(LETTERBOX_FILL);
    expect(px(10, 16)).toBe(90);
    expect(px(10, 47)).toBe(90);
    expect(px(10, 48)).toBe(LETTERBOX_FILL);
  });

  it('copies an exact square through untouched (fresh buffer)', () => {
    const source = solid(64, 64, 7);
    const out = letterboxSquare(source, 64);
    expect(out.rgb.equals(source.rgb)).toBe(true);
    expect(out.rgb).not.toBe(source.rgb);
  });

  it('never upscales past the edge and keeps at least one pixel', () => {
    const out = letterboxSquare(solid(1, 1000, 50), 32);
    expect(out.width).toBe(32);
    expect(out.rgb.length).toBe(32 * 32 * 3);
  });

  it('resizeNearest samples the source grid deterministically', () => {
    const source = { width: 2, height: 1, rgb: Buffer.from([1, 1, 1, 9, 9, 9]) };
    const out = resizeNearest(source, 4, 1);
    expect([...out.rgb]).toEqual([1, 1, 1, 1, 1, 1, 9, 9, 9, 9, 9, 9]);
  });

  it('validates buffer length against the declared geometry', () => {
    expect(isWellFormedImage(solid(3, 2, 0))).toBe(true);
    expect(isWellFormedImage({ width: 3, height: 2, rgb: Buffer.alloc(17) })).toBe(false);
    expect(isWellFormedImage({ width: 0, height: 2, rgb: Buffer.alloc(0) })).toBe(false);
  });

  it('l2Normalize yields a unit vector and leaves a zero vector at zero', () => {
    const unit = l2Normalize([3, 4]);
    expect(unit[0]).toBeCloseTo(0.6);
    expect(unit[1]).toBeCloseTo(0.8);
    expect(l2Normalize([0, 0])).toEqual([0, 0]);
  });
});
