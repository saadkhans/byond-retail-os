import {
  bufferCarriesSensitiveText,
  containsSensitiveFreeText,
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
      // MULTI-CHARACTER separator runs between groups: a maximal run of
      // non-alphanumeric characters is ONE separator, so these chain and
      // join to the PAN exactly like single-character separators.
      ['4111 - 1111 - 1111 - 1111.mp4'],
      ['4111 -- 1111 __ 1111 .. 1111.mp4'],
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
      // CHANGING separators inside the chain: no consistent-separator
      // sub-run reaches 13 digits, but the full join is the raw PAN.
      ['4111-1111 1111-1111.mp4'],
      ['4111_1111-1111.1111.mp4'],
      ['4111.1111_1111 1111.mp4'],
      // Contiguous.
      ['4111111111111111.mp4'],
      // Overlong contiguous run (20 digits): every 13-19-digit window is
      // Luhn-tested, so a PAN padded with extra digits never hides.
      ['04111111111111111000.mp4'],
      // Luhn-valid 13-digit Visa test PAN whose VALUE sits inside the
      // epoch-milliseconds numeric range: the Luhn verdict wins — no
      // epoch-range exemption, with OR without a timestamp-like key.
      ['4000000000006.mp4'],
      ['scan_4000000000006.mp4'],
      ['timestamp_4000000000006.mp4'],
      // Luhn-valid epoch-ms value attached to a timestamp key: key context
      // never overrides a Luhn-valid window (1753622627001 IS Luhn-valid —
      // verified by direct computation).
      ['creation_time_1753622627001.mp4'],
      // Credential labels FUSED with their value in one token.
      ['cvv123.mp4'],
      ['pin1234.mp4'],
      ['pan4111111111111111.mp4'],
      ['shelf_cvv123.mp4'],
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
      // Epoch-ms value that is Luhn-INVALID (verified by computation):
      // legitimate encoder metadata passes because it fails Luhn, not
      // because of any timestamp-key exemption.
      ['creation_time_1753612345678.mp4'],
      // 20-digit contiguous run whose EVERY 13-19-digit window is
      // Luhn-invalid (verified by computation): overlong runs are windowed,
      // not blanket-rejected.
      ['11111111111111111111.mp4'],
      // Ordinary words that merely START with a credential label must not
      // trip the fused label+value screen (label must be followed by a
      // digit, not letters).
      ['pinch_zoom_test.mp4'],
      ['pink_flamingo.mp4'],
      ['panorama_shelf.mp4'],
      ['pancake_stand.mp4'],
      ['pinned_note.mp4'],
    ])('accepts %p', (name) => {
      expect(filenameCarriesSensitiveContent(name)).toBe(false);
    });

    it('camera-app timestamp filenames: the Luhn verdict wins per join', () => {
      // POLICY (Codex cycles 1-3): NO calendar-shape exemption. Each
      // VID_/PXL_ name joins its date+time groups into a single 14/17-digit
      // window that is ALWAYS Luhn-tested. The ~10% of real camera
      // filenames whose join happens to be Luhn-valid REJECT — accepted
      // reject-on-write overbreadth (operators rename the file). The
      // expected-reject stamps below were adjudicated by direct Luhn
      // computation over the joined digits; everything else must accept.
      const luhnValidVidStamps = new Set([
        '20260701_003531',
        '20260702_235959',
        '20260705_120000',
        '20260708_083015',
        '20260710_235959',
        '20260713_120000',
        '20260716_083015',
        '20260719_003531',
        '20260721_120000',
        '20260724_083015',
        '20260727_003531',
        '20260728_235959',
      ]);
      const luhnValidPxlStamps = new Set([
        '20260702_235959123',
        '20260704_083015123',
        '20260705_003531123',
        '20260707_120000123',
        '20260710_003531123',
        '20260712_120000123',
        '20260716_235959123',
        '20260718_083015123',
        '20260721_235959123',
        '20260723_083015123',
        '20260726_120000123',
      ]);
      for (let day = 1; day <= 28; day += 1) {
        for (const hhmmss of ['003531', '120000', '235959', '083015']) {
          const dd = String(day).padStart(2, '0');
          const vidStamp = `202607${dd}_${hhmmss}`;
          expect(filenameCarriesSensitiveContent(`VID_${vidStamp}.mp4`)).toBe(
            luhnValidVidStamps.has(vidStamp),
          );
          const pxlStamp = `202607${dd}_${hhmmss}123`;
          expect(filenameCarriesSensitiveContent(`PXL_${pxlStamp}.mp4`)).toBe(
            luhnValidPxlStamps.has(pxlStamp),
          );
        }
      }
    });
  });

  describe('containsSensitiveFreeText (audit/screening-note free-text screen)', () => {
    it.each([
      // key=value / key: value credential fragments.
      ['operator note password=hunter2'],
      ['token: abc123 issued for retest'],
      // Bare well-known secret tokens.
      ['pasted sk_live_abcdefghijklmnop by mistake'],
      // Fused credential label + value in one token.
      ['card read cvv123 during test'],
      ['keypad pin1234 visible'],
      // Grouping-aware PAN windows under the Luhn-wins policy.
      ['card 4111 - 1111 - 1111 - 1111 visible in frame'],
      ['pan4111111111111111 seen on receipt'],
      ['ref 4000000000006 end'],
    ])('rejects %p', (text) => {
      expect(containsSensitiveFreeText(text)).toBe(true);
    });

    it.each([
      ['approved: shelf occlusion acceptable, retest cam3'],
      ['rejected due to glare on aisle 4 between 10:00 and 10:15'],
      ['pinch-zoom artifact near panorama seam, keep clip'],
      ['clip recorded 2026-07-27, duration 00:00:10'],
    ])('accepts %p', (text) => {
      expect(containsSensitiveFreeText(text)).toBe(false);
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
        '4111-1111 1111-1111', // CHANGING separators — full-chain join
        '4111.1111-1111_1111', // every separator different
        '4111 - 1111 - 1111 - 1111', // MULTI-CHAR separator runs
        '4111 -- 1111 __ 1111 .. 1111', // longer mixed separator runs
        '04111111111111111000', // PAN inside an overlong contiguous run
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

    it('accepts Luhn-INVALID timestamp/epoch metadata values', () => {
      // Encoder/creation metadata carries 14-digit datetimes and 13-digit
      // epoch milliseconds. Under the Luhn-wins policy they pass because
      // their digit joins fail Luhn (verified by direct computation) — NOT
      // because of any calendar-shape or timestamp-key exemption.
      for (const value of [
        'modify_date 20260727113347', // Luhn-invalid 14-digit datetime
        'stamp 20260727_113347', // same digits, 8-6 grouped
        'creation 1753612345678', // Luhn-invalid epoch-ms
        'creation_time=1753612345678', // Luhn-invalid epoch, key=value form
        'ts 1753612345678', // Luhn-invalid epoch, short key form
        'shoot 2026-07-27-11-33-47', // ISO datetime — join is Luhn-invalid
        'serial 66006800686644864268 end', // 20 digits, EVERY window Luhn-invalid
      ]) {
        const payload = Buffer.concat([
          Buffer.alloc(2),
          Buffer.from(value, 'ascii'),
          Buffer.alloc(2),
        ]);
        expect(bufferCarriesSensitiveText(payload)).toBe(false);
      }
    });

    it('rejects EVERY Luhn-valid 13-19-digit window — key context never overrides', () => {
      // GOVERNING POLICY: the Luhn verdict always wins. 4000000000006 (the
      // 13-digit Visa test PAN), 1753622627001 (a Luhn-VALID epoch-ms
      // value), and 20260701003531 (a Luhn-VALID calendar datetime) all
      // reject even when attached to a timestamp-like key — an exemption
      // there would be a laundering channel for real card data. The Luhn
      // false-positive rate on timestamp shapes (~10%) is the documented
      // reject-on-write overbreadth.
      for (const value of [
        'ref 4000000000006 end',
        'timestamp=4000000000006', // Finding 3: timestamp key must NOT rescue
        'scan 1753622627001 done',
        'creation_time=1753622627001', // Luhn-valid epoch behind a timestamp key
        'ts 1753622627001',
        'modify_date 20260701003531', // Luhn-valid calendar datetime
        'ref 04111111111111111000 end', // Finding 4: PAN inside 20-digit run
      ]) {
        const payload = Buffer.concat([
          Buffer.alloc(2),
          Buffer.from(value, 'ascii'),
          Buffer.alloc(2),
        ]);
        expect(bufferCarriesSensitiveText(payload)).toBe(true);
      }
    });

    it('finds fused credential label+value tokens in metadata text', () => {
      for (const fragment of ['cvv123', 'pin1234', 'pan4111111111111111']) {
        const payload = Buffer.concat([
          Buffer.alloc(2),
          Buffer.from(`comment ${fragment} end`, 'ascii'),
          Buffer.alloc(2),
        ]);
        expect(bufferCarriesSensitiveText(payload)).toBe(true);
      }
    });

    it('accepts ordinary words that merely start with a credential label', () => {
      const payload = Buffer.concat([
        Buffer.alloc(2),
        Buffer.from('pinch to zoom, panorama pan tilt, pink pancake', 'ascii'),
        Buffer.alloc(2),
      ]);
      expect(bufferCarriesSensitiveText(payload)).toBe(false);
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

    it('accepts ISO 6709 GPS location atoms whose digit joins are Luhn-invalid', () => {
      // Under the Luhn-wins policy GPS shape is NOT an exemption: coordinate
      // digit groups are windowed and Luhn-tested like any other chain.
      // Most real coordinates pass because every 13-19-digit window of
      // their joins fails Luhn — verified by direct computation for each
      // value below (including the "ISO6709" digits in the atom key, which
      // join into the chain).
      for (const iso6709 of [
        '+48.8577+002.2950/',
        '-33.8688+151.2093+058.000/',
        '+35.6581+139.7017+040.000/',
        '-22.9519-043.2105+710.000/',
        '+51.5007-000.1246+035.000/',
      ]) {
        const payload = Buffer.concat([
          Buffer.alloc(4),
          Buffer.from(`com.apple.quicktime.location.ISO6709${iso6709}`, 'ascii'),
          Buffer.alloc(4),
        ]);
        expect(bufferCarriesSensitiveText(payload)).toBe(false);
      }
    });

    it('rejects GPS-shaped chains whose digit joins ARE Luhn-valid (no coordinate exemption)', () => {
      // Finding 2: '+41.111111+111.11111/' is a syntactically valid ISO
      // 6709 chain whose joined digits are 4111111111111111 — a PAN dressed
      // as coordinates. Coordinate shape must never act as a window
      // barrier; the Luhn verdict wins. Legitimate coordinates whose joins
      // happen to be Luhn-valid (the other two values, verified by
      // computation) reject too — accepted overbreadth.
      for (const iso6709 of [
        '+41.111111+111.11111/', // joins to the 16-digit Visa test PAN
        '-26.2050-67.9749+14.431/', // real-shaped; 17-digit join is Luhn-valid
        '+37.3349-122.0090+021.000/', // real-shaped; 19/13-digit joins Luhn-valid
      ]) {
        const payload = Buffer.concat([
          Buffer.alloc(4),
          Buffer.from(`com.apple.quicktime.location.ISO6709${iso6709}`, 'ascii'),
          Buffer.alloc(4),
        ]);
        expect(bufferCarriesSensitiveText(payload)).toBe(true);
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
