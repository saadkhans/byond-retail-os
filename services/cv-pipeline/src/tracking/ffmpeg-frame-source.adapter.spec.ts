import {
  FfmpegFrameSource,
  MAX_FILE_SEEK_MS,
  buildFrameArgs,
  violatesCredentialFreeRule,
} from './ffmpeg-frame-source.adapter';

describe('violatesCredentialFreeRule', () => {
  it.each([
    'rtsp://camera.local/stream1',
    'rtsps://camera.local:8554/stream1',
    'http://127.0.0.1:8080/feed',
    'C:\\media\\pilot.mp4',
    '/var/media/pilot.mp4',
    'pilot-clip.mp4',
  ])('accepts the credential-free source %s', (value) => {
    expect(violatesCredentialFreeRule(value)).toBe(false);
  });

  it.each([
    ['userinfo in the authority', 'rtsp://user:pass@camera.local/stream1'],
    ['a bare user', 'rtsp://user@camera.local/stream1'],
    ['a query string', 'rtsp://camera.local/stream1?token=abc'],
    ['a fragment', 'rtsp://camera.local/stream1#frag'],
    ['a query on a generic scheme', 'https://host/path?key=secret'],
  ])('rejects %s', (_label, value) => {
    expect(violatesCredentialFreeRule(value)).toBe(true);
  });

  it('rejects a credential-bearing camera URL hidden behind a prefix', () => {
    // argv is visible to process listings, so a prefix must not be a way
    // to smuggle a credential past a start-anchored check.
    expect(
      violatesCredentialFreeRule('input=rtsp://user:pass@camera.local/x'),
    ).toBe(true);
    expect(
      violatesCredentialFreeRule('ffmpeg:rtsp://camera.local/x?token=abc'),
    ).toBe(true);
  });

  it('holds mixed-case schemes to the same rule', () => {
    expect(violatesCredentialFreeRule('RTSP://user@camera.local/x')).toBe(true);
  });
});

describe('buildFrameArgs', () => {
  const options = { width: 320, height: 240, timeoutMs: 5_000 };

  it('passes the source as a single argument and asks for raw RGB', () => {
    const args = buildFrameArgs('rtsp://camera.local/stream1', options);

    expect(args).toContain('rtsp://camera.local/stream1');
    // One argv entry, so no shell can ever re-read it as syntax.
    expect(
      args.filter((arg) => arg.includes('camera.local')),
    ).toHaveLength(1);
    expect(args[args.indexOf('-i') + 1]).toBe('rtsp://camera.local/stream1');
    expect(args).toContain('rawvideo');
    expect(args).toContain('rgb24');
    expect(args).toContain('320x240');
    expect(args).toContain('pipe:1');
  });

  it('uses TCP transport for a real stream and never seeks it', () => {
    const args = buildFrameArgs('rtsp://camera.local/stream1', {
      ...options,
      seekMs: 5_000,
    });

    expect(args).toContain('-rtsp_transport');
    expect(args).toContain('tcp');
    expect(args).not.toContain('-ss');
  });

  it('seeks a file source so tracking sees inter-frame motion', () => {
    const args = buildFrameArgs('pilot.mp4', { ...options, seekMs: 2_500 });

    expect(args).toContain('-ss');
    expect(args[args.indexOf('-ss') + 1]).toBe('2.500');
    expect(args).not.toContain('-rtsp_transport');
  });

  it('caps a runaway seek', () => {
    const args = buildFrameArgs('pilot.mp4', {
      ...options,
      seekMs: MAX_FILE_SEEK_MS * 100,
    });

    expect(args[args.indexOf('-ss') + 1]).toBe(
      (MAX_FILE_SEEK_MS / 1000).toFixed(3),
    );
  });

  it('treats a file merely named like a stream as a file', () => {
    const args = buildFrameArgs('rtsp-pilot.mp4', { ...options, seekMs: 1_000 });

    expect(args).toContain('-ss');
    expect(args).not.toContain('-rtsp_transport');
  });

  it('keeps ffmpeg quiet so stderr carries nothing worth reading', () => {
    const args = buildFrameArgs('pilot.mp4', options);
    expect(args).toContain('-hide_banner');
    expect(args[args.indexOf('-loglevel') + 1]).toBe('error');
  });
});

describe('FfmpegFrameSource — controlled failures', () => {
  const options = { width: 64, height: 48, timeoutMs: 1_000 };

  it('reports an unconfigured source without spawning anything', async () => {
    const result = await new FfmpegFrameSource(null).sample(options);
    expect(result).toEqual({ ok: false, code: 'SOURCE_NOT_CONFIGURED' });
  });

  it('refuses a credential-bearing source before any spawn', async () => {
    const source = new FfmpegFrameSource('rtsp://user:pass@camera.local/x');
    const result = await source.sample(options);
    expect(result).toEqual({
      ok: false,
      code: 'SOURCE_CREDENTIALS_UNSUPPORTED',
    });
  });

  it('never returns the configured source in a failure', async () => {
    const secret = 'rtsp://user:pass@camera.local/private-stream';
    const result = await new FfmpegFrameSource(secret).sample(options);

    // The whole result object, serialised — the address must appear
    // nowhere in it. This is the module's contract.
    expect(JSON.stringify(result)).not.toContain('camera.local');
    expect(JSON.stringify(result)).not.toContain('pass');
  });

  it('declares that it reads real bytes', () => {
    const source = new FfmpegFrameSource('pilot.mp4');
    expect(source.readsRealBytes).toBe(true);
    expect(source.kind).toBe('ffmpeg');
  });
});
