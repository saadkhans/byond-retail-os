import { SPLIT_BUCKET_SPACE, splitBucket } from './dataset-hash';

describe('splitBucket', () => {
  it('is deterministic for a fixed key', () => {
    const key = 'tenant-1:run-1:session-1';
    const first = splitBucket(key);
    for (let i = 0; i < 5; i += 1) {
      expect(splitBucket(key)).toBe(first);
    }
  });

  it('stays inside the bucket space', () => {
    for (let i = 0; i < 100; i += 1) {
      const bucket = splitBucket(`key-${i}`);
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThan(SPLIT_BUCKET_SPACE);
    }
  });

  it('distributes roughly evenly over an 70/15/15 partition', () => {
    // 10k distinct keys; each band should land near its share. The
    // tolerance is deliberately broad — this is a sanity check that the
    // hash is not degenerate, not a statistical proof.
    const counts = { train: 0, validation: 0, test: 0 };
    const total = 10_000;
    for (let i = 0; i < total; i += 1) {
      const bucket = splitBucket(`tenant:run:key-${i}`);
      if (bucket < 7000) {
        counts.train += 1;
      } else if (bucket < 8500) {
        counts.validation += 1;
      } else {
        counts.test += 1;
      }
    }
    expect(counts.train / total).toBeGreaterThan(0.6);
    expect(counts.train / total).toBeLessThan(0.8);
    expect(counts.validation / total).toBeGreaterThan(0.08);
    expect(counts.validation / total).toBeLessThan(0.22);
    expect(counts.test / total).toBeGreaterThan(0.08);
    expect(counts.test / total).toBeLessThan(0.22);
  });

  it('different keys can land in different buckets', () => {
    const buckets = new Set<number>();
    for (let i = 0; i < 50; i += 1) {
      buckets.add(splitBucket(`spread-${i}`));
    }
    expect(buckets.size).toBeGreaterThan(10);
  });
});
