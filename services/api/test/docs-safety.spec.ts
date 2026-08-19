import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Static safety check over the operator-facing CV docs: the documents
 * must exist, and the Phase 17 calibration doc must carry no stream
 * scheme, URL, drive-letter path, or credential-slot-looking string.
 * (The Phase 16 doc deliberately NAMES the rtsp scheme and the env-slot
 * pattern when explaining operator-managed configuration, so only the
 * existence check applies to it.)
 *
 * Forbidden needles are ASSEMBLED at runtime (same idiom as the camera
 * service specs) so no URL/secret-shaped literal appears in this file.
 */
describe('CV docs safety', () => {
  // __dirname = services/api/test → repo root is two levels up from
  // services/api.
  const docsDir = join(__dirname, '..', '..', '..', 'docs', 'cv');
  const phase16Doc = join(docsDir, 'live-footage-test-protocol.md');
  const phase17Doc = join(docsDir, 'camera-calibration-pilot-hardening.md');

  it('the Phase 16 and Phase 17 operator docs exist', () => {
    expect(existsSync(phase16Doc)).toBe(true);
    expect(existsSync(phase17Doc)).toBe(true);
  });

  it('the calibration doc contains no stream scheme, URL, drive path, or credential slot text', () => {
    const assemble = (...parts: string[]) => parts.join('');
    const text = readFileSync(phase17Doc, 'utf8');
    const lower = text.toLowerCase();
    // Stream scheme name (any casing).
    expect(lower).not.toContain(assemble('rt', 'sp'));
    // Any explicit URL (scheme separator).
    expect(text).not.toContain(assemble(':', '/', '/'));
    // Windows drive-letter path (C:\ or C:/).
    expect(text).not.toMatch(/[A-Za-z]:[\\/]/);
    // Backslash separators (UNC / Windows paths).
    expect(text).not.toContain('\\');
    // Credential-slot naming.
    expect(text).not.toContain(assemble('CAMERA_SECRET', '_SLOT'));
    expect(text).not.toContain(assemble('CAMERA_RTSP', '_SOURCE'));
    // Obvious media filename extensions.
    expect(lower).not.toMatch(/\.(mp4|mov|avi|mkv|m3u8)\b/);
  });

  it('both docs restate the shadow-only safety contract', () => {
    for (const doc of [phase16Doc, phase17Doc]) {
      const lower = readFileSync(doc, 'utf8').toLowerCase();
      expect(lower).toContain('shadow');
      expect(lower).toContain('inventory');
    }
  });
});
