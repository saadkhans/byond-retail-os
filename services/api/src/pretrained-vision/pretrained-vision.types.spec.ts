import {
  deriveActionCandidate,
  sanitizeProviderEvidence,
} from './pretrained-vision.types';

describe('sanitizeProviderEvidence — productId hardening (P2)', () => {
  const withCandidate = (productId: unknown) =>
    sanitizeProviderEvidence({
      provider: 'EMBEDDING_LOCAL',
      availability: 'READY',
      embeddingCandidates: [{ sku: 'SKU-A', productId, similarity: 0.7 }],
    }).embeddingCandidates[0];

  it.each([['prod_123'], ['cmf9x2k1a0001abcd'], ['prod-A-1']])(
    'accepts opaque identifier %s',
    (productId) => {
      expect(withCandidate(productId)?.productId).toBe(productId);
    },
  );

  it.each([
    ['a stream URL', 'rtsp' + '://secret'],
    ['a windows path', 'C:\\model\\weights'],
    ['a unix path', '/tmp/file'],
    ['a URL', 'https://provider.example/x'],
    ['a colon token', 'user:password'],
    ['a dotted path', '../etc/passwd'],
  ])('nulls out %s instead of passing it through', (_label, productId) => {
    const candidate = withCandidate(productId);
    // The candidate SURVIVES (the SKU label is the value) but the unsafe
    // string never leaves the sanitizer.
    expect(candidate?.sku).toBe('SKU-A');
    expect(candidate?.productId).toBeNull();
    expect(JSON.stringify(candidate)).not.toContain(String(productId));
  });
});

describe('deriveActionCandidate', () => {
  it('keeps UNKNOWN review-required when signals are inconclusive', () => {
    expect(
      deriveActionCandidate({
        handContact: false,
        objectDisappeared: true,
        objectAppeared: false,
      }),
    ).toBe('UNKNOWN');
    expect(
      deriveActionCandidate({
        handContact: true,
        objectDisappeared: null,
        objectAppeared: null,
      }),
    ).toBe('UNKNOWN');
  });

  it('maps contact + disappearance/appearance to PICKUP / RETURN / FALSE_TOUCH', () => {
    expect(
      deriveActionCandidate({
        handContact: true,
        objectDisappeared: true,
        objectAppeared: false,
      }),
    ).toBe('PICKUP');
    expect(
      deriveActionCandidate({
        handContact: true,
        objectDisappeared: false,
        objectAppeared: true,
      }),
    ).toBe('RETURN');
    expect(
      deriveActionCandidate({
        handContact: true,
        objectDisappeared: false,
        objectAppeared: false,
      }),
    ).toBe('FALSE_TOUCH');
  });
});
