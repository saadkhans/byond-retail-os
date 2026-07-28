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
      // NON-ASCII separators (pass filename hygiene — no control chars, no
      // path chars): the separator class is "not an ASCII alphanumeric",
      // so Unicode dashes/spaces chain digit groups like any '-'.
      ['4111—1111—1111—1111.mp4'], // em dash
      ['4111–1111–1111–1111.mp4'], // en dash
      ['4111 1111 1111 1111.mp4'], // NBSP separators
      ['4111—1111 1111•1111.mp4'], // mixed em dash/NBSP/bullet
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
      // LONG separated chains — beyond the 26 groups an earlier fixed
      // repetition cap could match. The exact P1 payload: 27 single-digit
      // groups whose final 16 digits join to 4111111111111111; the cap
      // split it into a 26-group first match (no Luhn-valid window inside —
      // verified by computation) plus an unscanned remainder, so it reached
      // storage. The full maximal chain must be windowed.
      ['3-4-3-0-3-3-0-1-1-1-9-4-1-1-1-1-1-1-1-1-1-1-1-1-1-1-1.mp4'],
      ['3_4_3_0_3_3_0_1_1_1_9_4_1_1_1_1_1_1_1_1_1_1_1_1_1_1_1.mp4'],
      // 32 groups with the PAN at the TAIL: the 16 decoy digits were chosen
      // by computation so the old 26-group first match (decoys + first 10
      // card digits) contains NO Luhn-valid window — only the full-chain
      // scan catches the trailing card.
      ['1-3-4-6-2-2-6-8-7-2-6-1-4-3-4-3-4-1-1-1-1-1-1-1-1-1-1-1-1-1-1-1.mp4'],
      // OVERSIZED separated groups (Codex P1 "window across oversized
      // separated digit groups"): first group = 8 zeros + the first 10 PAN
      // digits (18 digits), second group = the remaining 6. The aligned
      // join is 24 digits — the aligned scan abandons it — and NO window
      // inside the 18-digit contiguous group is Luhn-valid (verified by
      // computation), so only char-level windowing of the full 24-digit
      // join sees the Luhn-valid 16-digit card starting at offset 8.
      ['000000014111111111-111111.mp4'],
      // Same PAN, split at a different offset (16-digit group carrying 8
      // zeros + 8 card digits, then the remaining 8).
      ['0000000141111111-11111111.mp4'],
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
      // 32-group separated chain whose 32-digit join OVERFLOWS 19, so it
      // now gets FULL CHAR-LEVEL windowing on top of the aligned scan —
      // and stays an accept: EVERY 13-19-digit substring of '37'x16 is
      // Luhn-INVALID (recomputed for the char-level rule: 0 of the 119
      // windows pass Luhn). Overflow chains are windowed, never
      // blanket-rejected by length.
      [`${'37'.repeat(16).split('').join('_')}.mp4`],
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
      // NOTE (repo-owner directive): NO secret-looking provider-prefix
      // fixtures in this file, even concatenated. Direct coverage for the
      // containsKnownSecretToken branch (provider-prefixed tokens, JWTs)
      // lives in src/common/sensitive-keys.spec.ts; this spec exercises
      // the other branches with safe synthetic strings only.
      ['credential token pin 9911'], // spaced numeric label, fused wording
      ['fused csc998 read from keypad overlay'],
      // Fused credential label + value in one token.
      ['card read cvv123 during test'],
      ['keypad pin1234 visible'],
      // Grouping-aware PAN windows under the Luhn-wins policy.
      ['card 4111 - 1111 - 1111 - 1111 visible in frame'],
      ['pan4111111111111111 seen on receipt'],
      ['ref 4000000000006 end'],
      // Codex full-matrix vectors, direct at the free-text level (the
      // filename/buffer specs cover the same shapes in their channels).
      ['4111_1111_1111_1111'],
      ['4111.1111.1111.1111'],
      ['ref 04111111111111111000 end'], // PAN window inside an overlong run
      // 27-group P1 payload: the tail 16 single-digit groups join to the
      // Visa test PAN — the COMPLETE chain is windowed, no group cap.
      ['3-4-3-0-3-3-0-1-1-1-9-4-1-1-1-1-1-1-1-1-1-1-1-1-1-1-1'],
      // OVERSIZED separated groups (Codex P1): the 24-digit aligned join
      // overruns 19, so only char-level windowing over the full join sees
      // the Luhn-valid card crossing the group boundary at offset 8.
      ['000000014111111111-111111'],
      ['ref 0000000141111111-11111111 end'], // same PAN, different split
      // OCR whitespace between a credential label and its value (Codex P1
      // "scan credential labels separated by OCR whitespace"): fused needs
      // label+digit contiguous and key=value needs '='/':' — these carry
      // neither, only \s (including OCR line breaks and doubled spaces).
      ['CVV 123'],
      ['cvv\n123'], // OCR line break between label and digits
      ['PIN  1234'], // double space
      ['pin\t9876'], // tab
      ['csc 998 read from keypad'],
      ['camera pan 45 during sweep'], // pan-angle FP — accepted overbreadth
      ['password hunter2'],
      ['PASSWORD HUNTER2'],
      ['passwd hunter2'],
      ['pwd\nhunter2'], // OCR line break between label and value
      ['password\nhunter2'], // full label form across an OCR line break
      // PINNED: a 6+ char token after 'password' rejects even when it is
      // prose — 'password=redacted'/'password: redacted' already reject
      // via the shared key=value screen, and the whitespace form mirrors
      // that verdict (reject-on-write overbreadth).
      ['password redacted'],
      // Separators OUTSIDE printable ASCII must not split a grouped PAN
      // (Codex P1): whitespace controls, Unicode dashes/spaces, and
      // mixtures all chain digit groups — the separator class is "not an
      // ASCII alphanumeric", so nothing short of a letter breaks a chain.
      ['card\n4111\n1111\n1111\n1111\nvisible'], // newlines
      ['4111\t1111\r\n1111\t1111'], // tabs + CRLF
      ['4111—1111—1111—1111'], // em dash (literal U+2014)
      ['4111\u20141111\u20141111\u20141111'], // em dash (\u2014 escape)
      [['4111', '1111', '1111', '1111'].join(String.fromCharCode(0xa0))], // NBSP
      [['4111', '1111', '1111', '1111'].join(String.fromCharCode(0x3000))], // ideographic space
      ['4111 • 1111 — 1111\n1111'], // mixed bullet / em dash / newline
    ])('rejects %p', (text) => {
      expect(containsSensitiveFreeText(text)).toBe(true);
    });

    it.each([
      ['approved: shelf occlusion acceptable, retest cam3'],
      ['rejected due to glare on aisle 4 between 10:00 and 10:15'],
      ['pinch-zoom artifact near panorama seam, keep clip'],
      ['clip recorded 2026-07-27, duration 00:00:10'],
      // 'pin' INSIDE words never exposes a whitespace-separated label —
      // the label needs a non-alphanumeric left boundary AND \s before the
      // digits ('pinned' puts a letter on both sides).
      ['pinned annotation at aisle 4'],
      ['pinch 4 fingers to zoom before retest'],
      // Secret-word labels WITHOUT a value-shaped token after them: the
      // next token has no digit and is under 6 chars, so discussion-only
      // mentions stay clean ('password redacted' is pinned as a REJECT
      // above — 6+ chars mirrors the '='/':' screens' verdict).
      ['password ok'],
      ['password reset requested by ops'],
      // MULTI-LINE notes: newlines now chain digit groups, so these guard
      // the main false-positive classes. The newline-joined datetime join
      // (20260727113347) is Luhn-INVALID — verified by computation; the
      // 'T' in ISO 8601 datetimes is a letter and breaks the chain anyway.
      ['approved 2026-07-27\n11:33:47 retest cam3'],
      ['start 2026-07-27T11:33:47\nend 2026-07-27T11:35:12'],
      ['build 61.1.100\nversion 10.0.26200\nrev 4.2'],
      ['v1.2.3\n4.5.6\n7.8.9'],
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

    it('finds long separated chains (past the old 26-group cap) in metadata', () => {
      // The P1 payload (27 single-digit groups, PAN in the tail 16) and the
      // computed 32-group tail-PAN chain must reject; the 32-group '37'
      // chain must still accept — its 32-digit join overflows 19 and is
      // now char-level windowed in full, and EVERY 13-19-digit substring
      // of '37'x16 is Luhn-invalid (recomputed: 0 of 119 windows pass).
      const cases: Array<[string, boolean]> = [
        ['3-4-3-0-3-3-0-1-1-1-9-4-1-1-1-1-1-1-1-1-1-1-1-1-1-1-1', true],
        ['1-3-4-6-2-2-6-8-7-2-6-1-4-3-4-3-4-1-1-1-1-1-1-1-1-1-1-1-1-1-1-1', true],
        ['37'.repeat(16).split('').join('-'), false],
      ];
      for (const [chain, expected] of cases) {
        const payload = Buffer.concat([
          Buffer.alloc(2),
          Buffer.from(`ref ${chain} end`, 'ascii'),
          Buffer.alloc(2),
        ]);
        expect(bufferCarriesSensitiveText(payload)).toBe(expected);
      }
    });

    it('finds a PAN crossing an OVERSIZED group boundary in metadata bytes (Codex P1)', () => {
      // Payload-bytes form of the oversized-group finding: the 24-digit
      // aligned join overruns 19, so only the char-level windowing of the
      // full join sees the Luhn-valid card crossing the group boundary.
      for (const chain of [
        '000000014111111111-111111',
        '0000000141111111-11111111', // same PAN, split at a different offset
      ]) {
        const payload = Buffer.concat([
          noise,
          Buffer.alloc(2),
          Buffer.from(`ref ${chain} end`, 'ascii'),
          Buffer.alloc(2),
          noise,
        ]);
        expect(bufferCarriesSensitiveText(payload)).toBe(true);
      }
    });

    it('finds OCR-style whitespace-separated credential labels in metadata text', () => {
      // Subtitle/comment atoms can carry the same label-space-value shapes
      // OCR produces; spaces are printable, so the run reaches the shared
      // containsSensitiveFreeText screen intact. (A label split from its
      // value by a REAL line break in raw bytes is covered too — the
      // spaced-label detectors also run over each FULL decoded view; see
      // the line-break tests below.)
      for (const fragment of ['CVV 123', 'PIN  1234', 'password hunter2']) {
        const payload = Buffer.concat([
          noise,
          Buffer.alloc(2),
          Buffer.from(`note ${fragment} end`, 'ascii'),
          Buffer.alloc(2),
          noise,
        ]);
        expect(bufferCarriesSensitiveText(payload)).toBe(true);
      }
    });

    it('finds credential labels split from their values by REAL line breaks in metadata bytes', () => {
      // A raw \n between label and value splits the pair into TWO printable
      // runs ('note cvv' / '123 end'), neither of which the run-level
      // screen rejects — the spaced-label detectors now run over each FULL
      // decoded view, so the pair is seen across the line break.
      for (const fragment of ['cvv\n123', 'password\nhunter2', 'pin\r\n1234']) {
        const payload = Buffer.concat([
          noise,
          Buffer.alloc(2),
          Buffer.from(`note ${fragment} end`, 'utf8'),
          Buffer.alloc(2),
          noise,
        ]);
        expect(bufferCarriesSensitiveText(payload)).toBe(true);
      }
    });

    it('finds UTF-16 credential labels split from their values by a real newline', () => {
      // In the latin1 view 'PIN\n1234' as UTF-16LE is P\0I\0N\0\n\0 1\0... —
      // the 0x00 interleave breaks \s+digit adjacency, so ONLY the UTF-16
      // views can catch it; this pins the spaced-label scan to every view,
      // not just latin1.
      const le = Buffer.from('PIN\n1234', 'utf16le');
      const lePayload = Buffer.concat([
        noise,
        Buffer.alloc(2),
        le,
        Buffer.alloc(2),
        noise,
      ]);
      expect(bufferCarriesSensitiveText(lePayload)).toBe(true);
      // UTF-16BE (byte-swapped) lands on the odd-offset LE view; padding
      // spaces keep the label's word boundary intact at either parity.
      const be = Buffer.from('  password\nhunter2  ', 'utf16le').swap16();
      const bePayload = Buffer.concat([noise, Buffer.alloc(2), be, noise]);
      expect(bufferCarriesSensitiveText(bePayload)).toBe(true);
    });

    it.each([
      ['newlines', '4111\n1111\n1111\n1111'],
      ['CRLF pairs', '4111\r\n1111\r\n1111\r\n1111'],
      ['tabs', '4111\t1111\t1111\t1111'],
      ['em dashes', '4111—1111—1111—1111'],
      ['en dashes', '4111–1111–1111–1111'],
      ['bullets', '4111 • 1111 • 1111 • 1111'],
      ['NBSPs', ['4111', '1111', '1111', '1111'].join(String.fromCharCode(0xa0))],
      [
        'ideographic spaces',
        ['4111', '1111', '1111', '1111'].join(String.fromCharCode(0x3000)),
      ],
      ['mixed em dash/newline/spaced dash', '4111—1111\n1111 - 1111'],
    ])(
      'finds a PAN behind %s separators in UTF-8 payload bytes (Codex P1)',
      (_label, pan) => {
        // Buffer.from(..., 'utf8') exercises the BYTE-level path: each
        // non-ASCII separator becomes a MULTI-BYTE UTF-8 sequence (em dash
        // U+2014 → E2 80 94, NBSP U+00A0 → C2 A0) whose bytes are all
        // non-alphanumeric in the latin1 decode, so the full-view chain
        // scan joins the digit groups across them; \n/\r/\t are outside
        // printable ASCII, so only the full-view scan — never the
        // printable-run extraction — can see these chains.
        const payload = Buffer.concat([
          noise,
          Buffer.alloc(2),
          Buffer.from(`meta ${pan} end`, 'utf8'),
          Buffer.alloc(2),
          noise,
        ]);
        expect(bufferCarriesSensitiveText(payload)).toBe(true);
      },
    );

    it('finds PANs behind non-ASCII separators in UTF-16 metadata text', () => {
      // In the UTF-16LE views the em dash decodes to the single U+2014
      // code unit — non-alphanumeric, so the chain joins. (The latin1 view
      // independently joins the digits across the NUL interleave.)
      const pan = '4111—1111—1111—1111';
      const lePayload = Buffer.concat([
        noise,
        Buffer.alloc(2),
        Buffer.from(pan, 'utf16le'),
        Buffer.alloc(2),
        noise,
      ]);
      expect(bufferCarriesSensitiveText(lePayload)).toBe(true);
      const be = Buffer.from(`  ${pan}  `, 'utf16le').swap16();
      const bePayload = Buffer.concat([noise, Buffer.alloc(2), be, noise]);
      expect(bufferCarriesSensitiveText(bePayload)).toBe(true);
    });

    it('accepts multi-line metadata: ISO datetimes and version/build strings', () => {
      // Newlines now JOIN digit groups, so multi-line metadata is the main
      // new false-positive class. These pass because their window joins
      // are Luhn-INVALID (newline-joined 20260727113347 — verified by
      // computation) or under 13 digits ('T' is a letter and breaks ISO
      // 8601 datetime chains) — never via a shape exemption.
      for (const value of [
        'created 2026-07-27\n11:33:47',
        'start 2026-07-27T11:33:47\nend 2026-07-27T11:35:12',
        'build 61.1.100\nversion 10.0.26200\nrev 4.2',
        'v1.2.3\n4.5.6\n7.8.9',
      ]) {
        const payload = Buffer.concat([
          Buffer.alloc(2),
          Buffer.from(value, 'utf8'),
          Buffer.alloc(2),
        ]);
        expect(bufferCarriesSensitiveText(payload)).toBe(false);
      }
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

    it('finds a multi-char-separated PAN spanning >256 bytes across a chunk boundary', () => {
      // Overlap regression: with the group cap removed, a PAN stretched
      // with long separator runs is the boundary-straddling shape the 2 KiB
      // overlap must cover. This 316-byte chain starts 30 bytes before the
      // 1 MiB boundary and ends 286 bytes after it — beyond the old 256-byte
      // overlap (neither truncated chunk view contained a full PAN window —
      // verified by simulation), inside the 2 KiB one.
      const chunk = 1024 * 1024;
      const stretched = ['4111', '1111', '1111', '1111'].join('-'.repeat(100));
      expect(stretched.length).toBe(316);
      const payload = Buffer.concat([
        Buffer.alloc(chunk - 30), // NULs — not printable
        Buffer.from(stretched, 'ascii'),
        Buffer.alloc(64),
      ]);
      expect(bufferCarriesSensitiveText(payload)).toBe(true);
    });

    it('carries a >2 KiB separated PAN chain across the chunk boundary (content-aware carry)', () => {
      // Codex "PAN split across payload chunks": four digit groups joined
      // by 1500-dash separator runs — a 4516-byte chain, FAR past the old
      // fixed 2 KiB overlap. Positioned with g1 800 bytes BEFORE the 1 MiB
      // boundary: under the fixed overlap NEITHER view saw the chain whole
      // (chunk 1 ended at boundary+2048, before g3 at boundary+2208;
      // chunk 2 began at the boundary, after g1 — verified by position
      // arithmetic). The content-aware carry walks back through the
      // letter-free separator run, g1, and the NUL padding (cap 64 KiB)
      // and prepends it, so the second chunk decodes the chain whole.
      const chunk = 1024 * 1024;
      const sep = '-'.repeat(1500);
      const chain = ['4111', '1111', '1111', '1111'].join(sep);
      expect(chain.length).toBe(4516);
      const payload = Buffer.concat([
        Buffer.alloc(chunk - 800), // NULs — not printable, not letters
        Buffer.from(chain, 'ascii'),
        Buffer.alloc(64),
      ]);
      expect(bufferCarriesSensitiveText(payload)).toBe(true);
    });

    it('accepts the same straddling chain shape when the digit join is Luhn-invalid', () => {
      // Identical geometry, last group 1112: the 16-digit join fails Luhn,
      // so being seen whole via the carry must NOT flip it to reject — the
      // carry only widens visibility, never the verdict rules.
      const chunk = 1024 * 1024;
      const sep = '-'.repeat(1500);
      const chain = ['4111', '1111', '1111', '1112'].join(sep);
      const payload = Buffer.concat([
        Buffer.alloc(chunk - 800),
        Buffer.from(chain, 'ascii'),
        Buffer.alloc(64),
      ]);
      expect(bufferCarriesSensitiveText(payload)).toBe(false);
    });

    it('a letter in the straddling separator run breaks the chain and the carry (content-aware accept)', () => {
      // Same geometry as the reject case, but an ASCII letter sits in the
      // separator run 100 bytes before the boundary. In every decode view
      // the letter breaks the digit chain (g1 alone = 4 digits; g2..g4 =
      // 12 digits — no 13-digit window exists), so this accepts; and the
      // backward carry scan stops at that letter (only the 2 KiB floor is
      // carried), proving the carry is content-aware rather than a blanket
      // 64 KiB copy.
      const chunk = 1024 * 1024;
      const sep = '-'.repeat(1500);
      const bytes = Buffer.from(
        ['4111', '1111', '1111', '1111'].join(sep),
        'ascii',
      );
      bytes[800 - 100] = 0x58; // 'X' replaces a dash 100 bytes pre-boundary
      const payload = Buffer.concat([
        Buffer.alloc(chunk - 800),
        bytes,
        Buffer.alloc(64),
      ]);
      expect(bufferCarriesSensitiveText(payload)).toBe(false);
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

    it('accepts ISO 6709 GPS location atoms whose digit windows are all Luhn-invalid', () => {
      // Under the Luhn-wins policy GPS shape is NOT an exemption: coordinate
      // digit groups are windowed and Luhn-tested like any other chain
      // (including the "ISO6709" digits in the atom key, which join into
      // the chain). Chains whose full join is <=19 digits keep ALIGNED
      // windowing (the first value: 17-digit join); chains whose join
      // overflows 19 are now CHAR-LEVEL windowed in full, so a >19-join
      // coordinate accepts only when EVERY 13-19-digit substring of its
      // join fails Luhn — verified by direct computation for both 23-digit
      // joins below (0 Luhn-valid windows out of 56 each). Long precision
      // alone never blanket-rejects a location atom.
      for (const iso6709 of [
        '+48.8577+002.2950/', // 17-digit join — aligned-only, unchanged
        '+14.1822-085.5868+334.473/', // 23-digit join, all windows Luhn-invalid
        '-33.6530-165.5941+134.775/', // 23-digit join, all windows Luhn-invalid
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
        // FLIPPED accept → reject by the overflow char-level rule: these
        // real-shaped coordinates have 23-digit joins whose ALIGNED windows
        // are all Luhn-invalid (they accepted before), but char-level
        // windowing exposes Luhn-valid mid-group substrings (computed:
        // e.g. 8688151209305 at offset 6 of the first; 5190432105710 at
        // offset 7 of the third). Accepted overbreadth — the same window
        // rule that catches 000000014111111111-111111 applies to every
        // overflow chain, coordinate-shaped or not.
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
