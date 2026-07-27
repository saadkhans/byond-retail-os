import {
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
      // detector cannot see — normalized away before screening.
      ['4111_1111_1111_1111.mp4'],
      ['4111.1111.1111.1111.mp4'],
      ['4111-1111-1111-1111.mp4'],
      ['4111 1111 1111 1111.mp4'],
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
      ['1234_5678.mp4'], // digits, but no PAN
    ])('accepts %p', (name) => {
      expect(filenameCarriesSensitiveContent(name)).toBe(false);
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
