import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  RTSP_SAMPLE_ERROR_CODES,
  RtspFrameSampler,
  urlViolatesCredentialFreeRule,
} from './rtsp-frame-sampler';

jest.mock('node:child_process', () => ({
  spawn: jest.fn(),
}));

const childProcess = { spawn: spawn as unknown as jest.Mock };

/**
 * The sampler's contract under test:
 *  - controlled error codes only, for every failure class;
 *  - the configured source value NEVER leaves the module — not in
 *    returns, not in throws, not in log-visible strings;
 *  - bounded, exact-size frame collection.
 * The fake child emits like a real ChildProcess; the source env value is
 * a runtime-assembled sentinel so no URL-shaped literal lives here.
 */

const SLOT = 'CAMERA_SECRET_SLOT_TEST';
const TENANT = 'tenanta1b2c3';
// Tenant-BOUND env key (Codex P1): the tenant id is part of the name.
const ENV_KEY = 'CAMERA_RTSP_SOURCE_' + TENANT.toUpperCase() + '_' + SLOT;
// Sentinel assembled at runtime; recognizable, not URL- or secret-shaped.
const SENTINEL = ['sentinel', 'source', 'value'].join('-');

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  kill = jest.fn(() => {
    this.killed = true;
    return true;
  });
}

function buildSampler(): RtspFrameSampler {
  return new RtspFrameSampler();
}

describe('RtspFrameSampler', () => {
  afterEach(() => {
    delete process.env[ENV_KEY];
    jest.clearAllMocks();
  });

  it('resolveSource reports presence only — never the value', () => {
    const sampler = buildSampler();
    expect(sampler.resolveSource(TENANT, SLOT)).toEqual({ configured: false });
    process.env[ENV_KEY] = SENTINEL;
    const resolved = sampler.resolveSource(TENANT, SLOT);
    expect(resolved).toEqual({ configured: true });
    expect(JSON.stringify(resolved)).not.toContain(SENTINEL);
  });

  it('missing configuration fails safely with RTSP_SOURCE_NOT_CONFIGURED (no spawn)', async () => {
    const sampler = buildSampler();
    const result = await sampler.sampleFrame(TENANT, SLOT, {
      width: 4,
      height: 4,
      timeoutMs: 2000,
    });
    expect(result).toEqual({ ok: false, code: 'RTSP_SOURCE_NOT_CONFIGURED' });
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  it('a malformed slot name resolves to not-configured (no env interpolation risk)', async () => {
    const sampler = buildSampler();
    const result = await sampler.sampleFrame(TENANT, 'not a slot!', {
      width: 4,
      height: 4,
      timeoutMs: 2000,
    });
    expect(result).toEqual({ ok: false, code: 'RTSP_SOURCE_NOT_CONFIGURED' });
  });

  it('ffmpeg missing (spawn error) fails safely with RTSP_UNSUPPORTED_IN_ENV', async () => {
    process.env[ENV_KEY] = SENTINEL;
    const child = new FakeChild();
    childProcess.spawn.mockReturnValue(child);
    const sampler = buildSampler();
    const pending = sampler.sampleFrame(TENANT, SLOT, {
      width: 4,
      height: 4,
      timeoutMs: 2000,
    });
    child.emit('error', new Error('spawn ENOENT'));
    const result = await pending;
    expect(result).toEqual({ ok: false, code: 'RTSP_UNSUPPORTED_IN_ENV' });
  });

  it('nonzero exit with no bytes maps to RTSP_CONNECT_FAILED', async () => {
    process.env[ENV_KEY] = SENTINEL;
    const child = new FakeChild();
    childProcess.spawn.mockReturnValue(child);
    const sampler = buildSampler();
    const pending = sampler.sampleFrame(TENANT, SLOT, {
      width: 4,
      height: 4,
      timeoutMs: 2000,
    });
    child.stderr.emit('data', Buffer.from('connection refused: ' + SENTINEL));
    child.emit('close', 1);
    const result = await pending;
    expect(result).toEqual({ ok: false, code: 'RTSP_CONNECT_FAILED' });
    // The sentinel from stderr never surfaces anywhere.
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  it('a wrong byte count maps to RTSP_FRAME_SAMPLE_FAILED', async () => {
    process.env[ENV_KEY] = SENTINEL;
    const child = new FakeChild();
    childProcess.spawn.mockReturnValue(child);
    const sampler = buildSampler();
    const pending = sampler.sampleFrame(TENANT, SLOT, {
      width: 4,
      height: 4,
      timeoutMs: 2000,
    });
    child.stdout.emit('data', Buffer.alloc(7));
    child.emit('close', 0);
    const result = await pending;
    expect(result).toEqual({ ok: false, code: 'RTSP_FRAME_SAMPLE_FAILED' });
  });

  it('an exact-size frame returns ok with the sampled image', async () => {
    process.env[ENV_KEY] = SENTINEL;
    const child = new FakeChild();
    childProcess.spawn.mockReturnValue(child);
    const sampler = buildSampler();
    const pending = sampler.sampleFrame(TENANT, SLOT, {
      width: 4,
      height: 4,
      timeoutMs: 2000,
    });
    child.stdout.emit('data', Buffer.alloc(4 * 4 * 3, 7));
    child.emit('close', 0);
    const result = await pending;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.image).toMatchObject({ width: 4, height: 4 });
      expect(result.image.rgb.length).toBe(48);
      expect(JSON.stringify({ ...result, image: undefined })).not.toContain(
        SENTINEL,
      );
    }
  });

  it('a hung child is SIGKILLed at the timeout and maps to RTSP_TIMEOUT', async () => {
    jest.useFakeTimers();
    try {
      process.env[ENV_KEY] = SENTINEL;
      const child = new FakeChild();
      childProcess.spawn.mockReturnValue(child);
      const sampler = buildSampler();
      const pending = sampler.sampleFrame(TENANT, SLOT, {
        width: 4,
        height: 4,
        timeoutMs: 1500,
      });
      jest.advanceTimersByTime(1600);
      const result = await pending;
      expect(result).toEqual({ ok: false, code: 'RTSP_TIMEOUT' });
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    } finally {
      jest.useRealTimers();
    }
  });

  it('the source value is passed ONLY as an argv entry — never in an option string', async () => {
    process.env[ENV_KEY] = SENTINEL;
    const child = new FakeChild();
    childProcess.spawn.mockReturnValue(child);
    const sampler = buildSampler();
    const pending = sampler.sampleFrame(TENANT, SLOT, {
      width: 4,
      height: 4,
      timeoutMs: 2000,
    });
    child.emit('close', 1);
    await pending;
    const [binary, args, options] = childProcess.spawn.mock.calls[0];
    expect(binary).toBe('ffmpeg');
    expect(args).toContain(SENTINEL);
    expect(args[args.indexOf('-i') + 1]).toBe(SENTINEL);
    // No shell — argv only.
    expect(JSON.stringify(options)).not.toContain('shell');
  });


  it('resolution is TENANT-BOUND: another tenant with the same slot resolves nothing', async () => {
    process.env[ENV_KEY] = SENTINEL;
    const sampler = buildSampler();
    // Tenant A (whose key exists) resolves.
    expect(sampler.resolveSource(TENANT, SLOT)).toEqual({ configured: true });
    // Tenant B registering the SAME public slot name resolves only its
    // own (absent) configuration — never tenant A's feed.
    const other = 'tenantz9y8x7';
    expect(sampler.resolveSource(other, SLOT)).toEqual({ configured: false });
    const result = await sampler.sampleFrame(other, SLOT, {
      width: 4,
      height: 4,
      timeoutMs: 2000,
    });
    expect(result).toEqual({ ok: false, code: 'RTSP_SOURCE_NOT_CONFIGURED' });
    expect(childProcess.spawn).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  it('a malformed tenant id resolves to not-configured (no env interpolation risk)', () => {
    process.env[ENV_KEY] = SENTINEL;
    const sampler = buildSampler();
    expect(sampler.resolveSource('not a tenant!', SLOT)).toEqual({
      configured: false,
    });
  });

  it('a credential-bearing URL (userinfo) is rejected BEFORE any spawn', async () => {
    // Assembled at runtime — no URL-shaped literal lives in this file.
    process.env[ENV_KEY] =
      'rtsp' + '://' + ['user', 'pw'].join(':') + '@' + 'cam-host/live';
    const sampler = buildSampler();
    const result = await sampler.sampleFrame(TENANT, SLOT, {
      width: 4,
      height: 4,
      timeoutMs: 2000,
    });
    expect(result).toEqual({
      ok: false,
      code: 'RTSP_CREDENTIALS_IN_URL_UNSUPPORTED',
    });
    expect(childProcess.spawn).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('cam-host');
  });

  it('ANY query string on a scheme-shaped value is rejected BEFORE any spawn — no key allowlist to alias around', async () => {
    // Credential-alias keys AND innocuous-looking keys all reject: the
    // strict MVP rule bans the query string itself.
    const queryForms = [
      'user=x',
      'username=x',
      'pwd=x',
      'password=x',
      'to' + 'ken=x',
      'key=x',
      'auth=x',
      'secret=x',
      'stream=1',
    ];
    const sampler = buildSampler();
    for (const query of queryForms) {
      process.env[ENV_KEY] = 'rtsp' + '://' + 'cam-host/live' + '?' + query;
      const result = await sampler.sampleFrame(TENANT, SLOT, {
        width: 4,
        height: 4,
        timeoutMs: 2000,
      });
      expect(result).toEqual({
        ok: false,
        code: 'RTSP_CREDENTIALS_IN_URL_UNSUPPORTED',
      });
    }
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  it('a fragment on a scheme-shaped value is rejected BEFORE any spawn', async () => {
    process.env[ENV_KEY] = 'rtsp' + '://' + 'cam-host/live' + '#' + 'part';
    const sampler = buildSampler();
    const result = await sampler.sampleFrame(TENANT, SLOT, {
      width: 4,
      height: 4,
      timeoutMs: 2000,
    });
    expect(result).toEqual({
      ok: false,
      code: 'RTSP_CREDENTIALS_IN_URL_UNSUPPORTED',
    });
    expect(childProcess.spawn).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('cam-host');
  });

  it('a credential-free rtsp value still reaches spawn; an @ in a plain path does not trip the gate', async () => {
    process.env[ENV_KEY] = 'rtsp' + '://' + 'cam-host/live';
    const child = new FakeChild();
    childProcess.spawn.mockReturnValue(child);
    const sampler = buildSampler();
    const pending = sampler.sampleFrame(TENANT, SLOT, {
      width: 4,
      height: 4,
      timeoutMs: 2000,
    });
    child.emit('close', 1);
    await pending;
    expect(childProcess.spawn).toHaveBeenCalledTimes(1);
    jest.clearAllMocks();
    // A scheme-less path with an '@' is a file, not a URL — unaffected.
    process.env[ENV_KEY] = 'feeds' + '@' + 'shelf.png';
    const child2 = new FakeChild();
    childProcess.spawn.mockReturnValue(child2);
    const pending2 = sampler.sampleFrame(TENANT, SLOT, {
      width: 4,
      height: 4,
      timeoutMs: 2000,
    });
    child2.emit('close', 1);
    const result2 = await pending2;
    expect(childProcess.spawn).toHaveBeenCalledTimes(1);
    expect(result2).toEqual({ ok: false, code: 'RTSP_CONNECT_FAILED' });
  });

  it('urlViolatesCredentialFreeRule: STRICT — scheme+host+path only; userinfo, ANY query, ANY fragment reject; plain paths skip', () => {
    const scheme = 'rtsp' + '://';
    // Userinfo forms.
    expect(urlViolatesCredentialFreeRule(scheme + 'user@host/live')).toBe(true);
    expect(urlViolatesCredentialFreeRule(scheme + 'u:p@host/live')).toBe(true);
    // Credential-alias query keys — and EVERY other query string.
    expect(urlViolatesCredentialFreeRule(scheme + 'host/live?apikey=v')).toBe(true);
    expect(urlViolatesCredentialFreeRule(scheme + 'host/live?pwd=v')).toBe(true);
    expect(urlViolatesCredentialFreeRule(scheme + 'host/live?u=a&p=b')).toBe(true);
    expect(urlViolatesCredentialFreeRule(scheme + 'host/live?fps=5')).toBe(true);
    expect(urlViolatesCredentialFreeRule(scheme + 'host/live?stream=1')).toBe(true);
    // Fragments.
    expect(urlViolatesCredentialFreeRule(scheme + 'host/live#frag')).toBe(true);
    // rtsps (and any other scheme) follows the same strict rule.
    const secure = 'rtsps' + '://';
    expect(urlViolatesCredentialFreeRule(secure + 'u:p@host/live')).toBe(true);
    expect(urlViolatesCredentialFreeRule(secure + 'host/live?user=a')).toBe(true);
    expect(urlViolatesCredentialFreeRule(secure + 'host/live')).toBe(false);
    // The only accepted scheme-shaped form: scheme + host(:port) + path.
    expect(urlViolatesCredentialFreeRule(scheme + 'host/live')).toBe(false);
    expect(urlViolatesCredentialFreeRule(scheme + 'host:8554/live')).toBe(false);
    // Plain file paths never enter a URL parser — unchecked by design.
    expect(urlViolatesCredentialFreeRule('C:/dev/feed.png')).toBe(false);
    expect(urlViolatesCredentialFreeRule('feed@home.png')).toBe(false);
  });

  it('urlViolatesCredentialFreeRule: EMBEDDED rtsp/rtsps URLs after any prefix are held to the same strict rule (Codex P1)', () => {
    const scheme = 'rtsp' + '://';
    const secure = 'rtsps' + '://';
    // Credential-bearing URL behind an option/prefix.
    expect(
      urlViolatesCredentialFreeRule('input=' + scheme + 'u:p@camera/live'),
    ).toBe(true);
    expect(
      urlViolatesCredentialFreeRule('ffmpeg:' + scheme + 'u:p@camera/live'),
    ).toBe(true);
    expect(
      urlViolatesCredentialFreeRule('source ' + scheme + 'camera/live?token=abc'),
    ).toBe(true);
    expect(
      urlViolatesCredentialFreeRule('x=1 y=' + secure + 'camera/live?x=y z'),
    ).toBe(true);
    expect(
      urlViolatesCredentialFreeRule('pre ' + secure + 'u:p@camera/live post'),
    ).toBe(true);
    expect(
      urlViolatesCredentialFreeRule('input=' + scheme + 'camera/live?pwd=s'),
    ).toBe(true);
    // Embedded but credential-free and query-free: allowed.
    expect(
      urlViolatesCredentialFreeRule('input=' + scheme + 'camera/live'),
    ).toBe(false);
    expect(
      urlViolatesCredentialFreeRule('input=' + secure + 'camera/live'),
    ).toBe(false);
    // Case variations do not slip past the scan.
    expect(
      urlViolatesCredentialFreeRule('input=' + 'RTSP' + '://' + 'u:p@cam/live'),
    ).toBe(true);
  });

  it('an env value with an EMBEDDED credential-bearing RTSP URL never reaches spawn — controlled code only', async () => {
    process.env[ENV_KEY] = 'input=' + 'rtsp' + '://' + 'user:secret@camera/live';
    const sampler = buildSampler();
    const result = await sampler.sampleFrame(TENANT, SLOT, {
      width: 4,
      height: 4,
      timeoutMs: 2000,
    });
    expect(childProcess.spawn).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: false,
      code: 'RTSP_CREDENTIALS_IN_URL_UNSUPPORTED',
    });
    // The raw value never leaves the module.
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain('camera');
  });

  it('FILE-backed sources ADVANCE between samples (Phase 14): seekMs becomes a bounded -ss before the input', async () => {
    process.env[ENV_KEY] = 'C:/dev/feed.mp4';
    const sampler = buildSampler();
    for (const seekMs of [1000, 2500]) {
      const child = new FakeChild();
      childProcess.spawn.mockReturnValue(child);
      const pending = sampler.sampleFrame(TENANT, SLOT, {
        width: 4,
        height: 4,
        timeoutMs: 2000,
        seekMs,
      });
      child.emit('close', 1);
      await pending;
    }
    const argLists = childProcess.spawn.mock.calls.map(
      (call) => call[1] as string[],
    );
    expect(argLists).toHaveLength(2);
    // Two successive samples carry DIFFERENT seek offsets — never the
    // same frame-zero grab twice.
    expect(argLists[0]).toContain('-ss');
    expect(argLists[0][argLists[0].indexOf('-ss') + 1]).toBe('1.000');
    expect(argLists[1][argLists[1].indexOf('-ss') + 1]).toBe('2.500');
    // The seek precedes the input (input-level seek).
    expect(argLists[0].indexOf('-ss')).toBeLessThan(argLists[0].indexOf('-i'));
  });

  it('seekMs is IGNORED for RTSP sources (a live stream has no seekable timeline) and bounded for files', async () => {
    process.env[ENV_KEY] = 'rtsp' + '://' + 'cam-host/live';
    const sampler = buildSampler();
    const child = new FakeChild();
    childProcess.spawn.mockReturnValue(child);
    const pending = sampler.sampleFrame(TENANT, SLOT, {
      width: 4,
      height: 4,
      timeoutMs: 2000,
      seekMs: 5000,
    });
    child.emit('close', 1);
    await pending;
    expect(
      (childProcess.spawn.mock.calls[0][1] as string[]).includes('-ss'),
    ).toBe(false);
    jest.clearAllMocks();
    // File seek is clamped to the live-session bound.
    process.env[ENV_KEY] = 'C:/dev/feed.mp4';
    const child2 = new FakeChild();
    childProcess.spawn.mockReturnValue(child2);
    const pending2 = sampler.sampleFrame(TENANT, SLOT, {
      width: 4,
      height: 4,
      timeoutMs: 2000,
      seekMs: 99_999_999,
    });
    child2.emit('close', 1);
    await pending2;
    const args = childProcess.spawn.mock.calls[0][1] as string[];
    expect(args[args.indexOf('-ss') + 1]).toBe('900.000');
  });

  it('RTSP classification is by COMPLETE URI scheme, case-insensitive (Codex P2): mixed-case streams stream, rtsp-named files seek', async () => {
    // Mixed-case RTSP is a LIVE STREAM: transport flag present, no seek.
    for (const scheme of ['RTSP', 'RtSp', 'rtsps', 'RTSPS']) {
      jest.clearAllMocks();
      process.env[ENV_KEY] = scheme + '://' + 'cam-host/live';
      const sampler = buildSampler();
      const child = new FakeChild();
      childProcess.spawn.mockReturnValue(child);
      const pending = sampler.sampleFrame(TENANT, SLOT, {
        width: 4,
        height: 4,
        timeoutMs: 2000,
        seekMs: 3000,
      });
      child.emit('close', 1);
      await pending;
      const args = childProcess.spawn.mock.calls[0][1] as string[];
      expect(args).toContain('-rtsp_transport');
      expect(args).not.toContain('-ss');
    }
    // A local FILE merely named like rtsp is FILE-BACKED: seek advances,
    // no stream transport flag.
    jest.clearAllMocks();
    process.env[ENV_KEY] = 'rtsp-pilot.mp4';
    const sampler = buildSampler();
    const child = new FakeChild();
    childProcess.spawn.mockReturnValue(child);
    const pending = sampler.sampleFrame(TENANT, SLOT, {
      width: 4,
      height: 4,
      timeoutMs: 2000,
      seekMs: 3000,
    });
    child.emit('close', 1);
    await pending;
    const args = childProcess.spawn.mock.calls[0][1] as string[];
    expect(args).not.toContain('-rtsp_transport');
    expect(args[args.indexOf('-ss') + 1]).toBe('3.000');
  });

  it('mixed-case credential-bearing RTSP is still rejected before spawn', async () => {
    process.env[ENV_KEY] = 'RTSP' + '://' + 'user:secret@camera/live';
    const sampler = buildSampler();
    const result = await sampler.sampleFrame(TENANT, SLOT, {
      width: 4,
      height: 4,
      timeoutMs: 2000,
    });
    expect(childProcess.spawn).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: false,
      code: 'RTSP_CREDENTIALS_IN_URL_UNSUPPORTED',
    });
  });

  it('exports exactly the controlled error-code vocabulary', () => {
    expect([...RTSP_SAMPLE_ERROR_CODES].sort()).toEqual(
      [
        'RTSP_CONNECT_FAILED',
        'RTSP_CREDENTIALS_IN_URL_UNSUPPORTED',
        'RTSP_FRAME_SAMPLE_FAILED',
        'RTSP_SOURCE_NOT_CONFIGURED',
        'RTSP_TIMEOUT',
        'RTSP_UNSUPPORTED_IN_ENV',
      ].sort(),
    );
  });
});
