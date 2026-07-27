import {
  bufferCarriesSensitiveText,
  fileExtensionOf,
  filenameCarriesSensitiveContent,
  isAllowedVideoUpload,
  isUnsafeUploadFilename,
  looksLikeVideoContent,
  sanitizeOriginalFilename,
} from './media-safety';

describe('media-safety', () => {
  describe('isUnsafeUploadFilename', () => {
    it.each([
      ['../../../etc/passwd.mp4'],
      ['..\\..\\windows\\clip.mp4'],
      ['dir/clip.mp4'],
      ['dir\\clip.mp4'],
      ['C:clip.mp4'],
      ['clip..mp4'],
      ['.hidden.mp4'],
      [' padded.mp4'],
      ['padded.mp4 '],
      ['nul\u0000byte.mp4'],
      ['tab\tname.mp4'],
      [''],
    ])('rejects %p', (name) => {
      expect(isUnsafeUploadFilename(name)).toBe(true);
    });

    it.each([['clip.mp4'], ['shelf_test-01.MOV'], ['a.webm']])(
      'accepts %p',
      (name) => {
        expect(isUnsafeUploadFilename(name)).toBe(false);
      },
    );
  });

  describe('sanitizeOriginalFilename', () => {
    it('replaces unsafe characters and caps the length', () => {
      expect(sanitizeOriginalFilename('my clip (1)!.mp4')).toBe(
        'my_clip__1__.mp4',
      );
      const long = `${'a'.repeat(300)}.mp4`;
      expect(sanitizeOriginalFilename(long).length).toBe(160);
      expect(sanitizeOriginalFilename(long).endsWith('.mp4')).toBe(true);
    });
  });

  describe('filenameCarriesSensitiveContent', () => {
    it.each([
      // PANs hidden behind filename separators the shared space/dash
      // detector cannot see — grouping-aware detection catches them.
      ['4111_1111_1111_1111.mp4'],
      ['4111.1111.1111.1111.mp4'],
      ['4111-1111-1111-1111.mp4'],
      ['4111 1111 1111 1111.mp4'],
      // NONCANONICAL groupings: separator placement never launders a PAN.
      ['41111111-11111111.mp4'],
      ['4-111111111111111.mp4'],
      ['41111_11111_111111.mp4'],
      // Many-group shapes: digit pairs and single digits.
      ['41-11-11-11-11-11-11-11.mp4'],
      ['4_1_1_1_1_1_1_1_1_1_1_1_1_1_1_1.mp4'],
      // Decoy digit groups around the card never launder it.
      ['4111-1111-1111-1111-9.mp4'],
      ['99-4111-1111-1111-1111.mp4'],
      // ... not even behind a separator CHANGE.
      ['4111-1111-1111-1111.5.mp4'],
      // Contiguous.
      ['4111111111111111.mp4'],
      // Credential-channel tokens: the neighboring token IS the secret.
      ['password_hunter2.mp4'],
      ['api_key_prod.mp4'],
      ['secret-recording.mp4'],
    ])('rejects %p', (name) => {
      expect(filenameCarriesSensitiveContent(name)).toBe(true);
    });

    it.each([
      ['clip.mp4'],
      ['shelf_test-01.mov'],
      ['pickup_2026-07-27_cam3.mp4'],
      ['shot_2026-07-27-11-33-47.mp4'], // ISO datetime — timestamp semantics
      ['1234_5678.mp4'], // digits, but no PAN
    ])('accepts %p', (name) => {
      expect(filenameCarriesSensitiveContent(name)).toBe(false);
    });

    it('accepts EVERY default camera-app timestamp filename (no Luhn fabrication)', () => {
      // Strip-all-separators joins fabricated Luhn-valid runs from date+time
      // digits and deterministically rejected ~10% of real Android/Pixel/
      // GoPro clips (e.g. VID_20260701_003531.mp4). The grouping-aware
      // detector must accept ALL of them: date/time groupings (8-6, 8-9)
      // are never card groupings.
      for (let day = 1; day <= 28; day += 1) {
        for (const hhmmss of ['003531', '120000', '235959', '083015']) {
          const dd = String(day).padStart(2, '0');
          expect(
            filenameCarriesSensitiveContent(`VID_202607${dd}_${hhmmss}.mp4`),
          ).toBe(false);
          expect(
            filenameCarriesSensitiveContent(`PXL_202607${dd}_${hhmmss}123.mp4`),
          ).toBe(false);
        }
      }
    });
  });

  describe('bufferCarriesSensitiveText', () => {
    const noise = Buffer.from(
      Array.from({ length: 4096 }, (_, i) => (i * 37) % 256),
    );

    it('finds credential fragments embedded in container bytes', () => {
      // Container metadata atoms are length/NUL-delimited, so the text run
      // starts at the atom value — exactly how a real comment atom lands.
      const payload = Buffer.concat([
        noise,
        Buffer.alloc(2), // atom boundary (non-printable)
        Buffer.from('password=hunter2', 'ascii'),
        Buffer.alloc(2),
        noise,
      ]);
      expect(bufferCarriesSensitiveText(payload)).toBe(true);
    });

    it('finds SHORT credential fragments (cvv=123) below the old run floor', () => {
      // A 7-char run must still reach the credential screen — CVVs are
      // explicitly classified and the run floor must not discard them.
      for (const fragment of ['cvv=123', 'pin=9876', 'cvc=00']) {
        const payload = Buffer.concat([
          noise,
          Buffer.alloc(2),
          Buffer.from(fragment, 'ascii'),
          Buffer.alloc(2),
          noise,
        ]);
        expect(bufferCarriesSensitiveText(payload)).toBe(true);
      }
    });

    it('finds noncanonically grouped PANs in metadata text', () => {
      for (const pan of [
        '41111111-11111111',
        '4111111111111111',
        '41111_11111_111111',
        '41 11 11 11 11 11 11 11', // digit pairs, > 7 groups
        '4111-1111-1111-1111-9', // trailing decoy digit group
        '4111-1111-1111-1111.5', // decoy behind a separator change
      ]) {
        const payload = Buffer.concat([
          noise,
          Buffer.alloc(2),
          Buffer.from(`ref ${pan} end`, 'ascii'),
          Buffer.alloc(2),
          noise,
        ]);
        expect(bufferCarriesSensitiveText(payload)).toBe(true);
      }
    });

    it('accepts calendar timestamps and epoch-ms values (semantic exemption)', () => {
      // Encoder/creation metadata carries 14-digit datetimes and 13-digit
      // epoch milliseconds — Luhn-valid ones must NOT be treated as PANs.
      for (const value of [
        'modify_date 20260701003531',
        'stamp 20260701_003531',
        'creation 1753612345678',
        'shoot 2026-07-27-11-33-47', // ISO datetime, consistent separator
      ]) {
        const payload = Buffer.concat([
          Buffer.alloc(2),
          Buffer.from(value, 'ascii'),
          Buffer.alloc(2),
        ]);
        expect(bufferCarriesSensitiveText(payload)).toBe(false);
      }
    });

    it.each([
      ['4111 1111 1111 1111'],
      ['4111-1111-1111-1111'],
      ['4111_1111_1111_1111'],
      ['4111.1111.1111.1111'],
    ])('finds PAN %p in metadata text at any separator', (pan) => {
      const payload = Buffer.concat([
        noise,
        Buffer.from(`title:${pan}`, 'ascii'),
        noise,
      ]);
      expect(bufferCarriesSensitiveText(payload)).toBe(true);
    });

    it('finds sensitive text that straddles a scan-chunk boundary', () => {
      const chunk = 1024 * 1024;
      const pan = '4111 1111 1111 1111';
      const payload = Buffer.concat([
        Buffer.alloc(chunk - 10), // NULs — not printable
        Buffer.from(pan, 'ascii'),
        Buffer.alloc(64),
      ]);
      expect(bufferCarriesSensitiveText(payload)).toBe(true);
    });

    it('accepts ordinary container bytes and harmless metadata', () => {
      const payload = Buffer.concat([
        noise,
        Buffer.from('encoder=lavf61.1.100 creation_time 2026-07-27', 'ascii'),
        Buffer.from('handler=VideoHandler duration=10000', 'ascii'),
        noise,
      ]);
      expect(bufferCarriesSensitiveText(payload)).toBe(false);
    });

    it('accepts ISO 6709 GPS location atoms from real phone videos', () => {
      // Coordinate digit chains across '.', '+', '-' fabricated Luhn-valid
      // PAN candidates under the any-separator detector and rejected ~10%
      // of location-tagged clips. Mixed-separator chains are never card
      // groupings — all of these must pass.
      for (const iso6709 of [
        '-26.2050-67.9749+14.431/',
        '+37.3349-122.0090+021.000/',
        '+48.8577+002.2950/',
        '-33.8688+151.2093+058.000/',
      ]) {
        const payload = Buffer.concat([
          Buffer.alloc(4),
          Buffer.from(`com.apple.quicktime.location.ISO6709${iso6709}`, 'ascii'),
          Buffer.alloc(4),
        ]);
        expect(bufferCarriesSensitiveText(payload)).toBe(false);
      }
    });

    it('finds UTF-16-encoded credential and PAN text in metadata atoms', () => {
      // MP4 ilst data atoms (type 2) and ID3v2 frames (encoding 0x01) store
      // text as UTF-16 — a latin1-only scan sees isolated bytes and misses
      // it entirely.
      for (const [text, encoding] of [
        ['password=hunter2', 'utf16le'],
        ['card 4242 4242 4242 4242', 'utf16le'],
        ['4111_1111_1111_1111', 'utf16le'],
      ] as const) {
        const payload = Buffer.concat([
          noise,
          Buffer.alloc(2),
          Buffer.from(text, encoding),
          Buffer.alloc(2),
          noise,
        ]);
        expect(bufferCarriesSensitiveText(payload)).toBe(true);
      }
      // UTF-16BE (byte-swapped) ASCII is caught by the odd-offset view.
      // Padding spaces keep the 'password' word boundary intact whichever
      // byte parity the decode lands on.
      const be = Buffer.from('  password=hunter2  ', 'utf16le').swap16();
      const payload = Buffer.concat([noise, Buffer.alloc(2), be, noise]);
      expect(bufferCarriesSensitiveText(payload)).toBe(true);
    });

    it('finds SHORT UTF-16-encoded credential fragments (cvv=123)', () => {
      // The 7-char CVV fragment must survive the printable-run floor in the
      // UTF-16 views too, not only in the latin1 view.
      const le = Buffer.from('cvv=123', 'utf16le');
      const lePayload = Buffer.concat([
        noise,
        Buffer.alloc(2),
        le,
        Buffer.alloc(2),
        noise,
      ]);
      expect(bufferCarriesSensitiveText(lePayload)).toBe(true);
      const be = Buffer.from('  cvv=123  ', 'utf16le').swap16();
      const bePayload = Buffer.concat([noise, Buffer.alloc(2), be, noise]);
      expect(bufferCarriesSensitiveText(bePayload)).toBe(true);
    });
  });

  describe('extension/MIME allowlist', () => {
    it.each([
      ['clip.mp4', 'video/mp4', true],
      ['clip.mov', 'video/quicktime', true],
      ['clip.webm', 'video/webm', true],
      ['clip.mkv', 'video/x-matroska', true],
      ['clip.avi', 'video/x-msvideo', true],
      ['clip.mpg', 'video/mpeg', true],
      // Wrong MIME for the extension.
      ['clip.mp4', 'video/webm', false],
      // Executables/scripts/images are not videos.
      ['clip.exe', 'application/octet-stream', false],
      ['clip.sh', 'text/x-shellscript', false],
      ['clip.js', 'text/javascript', false],
      ['clip.jpg', 'image/jpeg', false],
      ['clip.png', 'image/png', false],
      // MIME smuggling under a video extension is caught by the pairing.
      ['clip.mp4', 'application/x-msdownload', false],
      ['clip', 'video/mp4', false],
    ])('%p + %p → %p', (name, mime, expected) => {
      expect(isAllowedVideoUpload(fileExtensionOf(name), mime)).toBe(expected);
    });
  });

  describe('looksLikeVideoContent (magic bytes)', () => {
    const mp4 = Buffer.concat([
      Buffer.from([0, 0, 0, 0x18]),
      Buffer.from('ftypmp42', 'ascii'),
      Buffer.alloc(16),
    ]);
    const mkv = Buffer.concat([
      Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
      Buffer.alloc(16),
    ]);
    const avi = Buffer.concat([
      Buffer.from('RIFF', 'ascii'),
      Buffer.alloc(4),
      Buffer.from('AVI ', 'ascii'),
      Buffer.alloc(8),
    ]);
    const mpeg = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x01, 0xba]),
      Buffer.alloc(16),
    ]);

    it('accepts real container headers', () => {
      expect(looksLikeVideoContent(mp4, '.mp4')).toBe(true);
      expect(looksLikeVideoContent(mp4, '.mov')).toBe(true);
      expect(looksLikeVideoContent(mkv, '.webm')).toBe(true);
      expect(looksLikeVideoContent(mkv, '.mkv')).toBe(true);
      expect(looksLikeVideoContent(avi, '.avi')).toBe(true);
      expect(looksLikeVideoContent(mpeg, '.mpg')).toBe(true);
    });

    it('rejects scripts and executables renamed to a video extension', () => {
      const script = Buffer.from('#!/bin/sh\nrm -rf /\n', 'ascii');
      const exe = Buffer.from('MZ', 'latin1');
      expect(looksLikeVideoContent(script, '.mp4')).toBe(false);
      expect(looksLikeVideoContent(exe, '.mp4')).toBe(false);
      expect(looksLikeVideoContent(script, '.mkv')).toBe(false);
      expect(looksLikeVideoContent(exe, '.avi')).toBe(false);
    });

    it('rejects unknown extensions and short buffers outright', () => {
      expect(looksLikeVideoContent(mp4, '.exe')).toBe(false);
      expect(looksLikeVideoContent(Buffer.alloc(2), '.mp4')).toBe(false);
    });
  });
});
