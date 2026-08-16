import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  RTSP_SAMPLE_ERROR_CODES,
  RtspFrameSampler,
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
const ENV_KEY = 'CAMERA_RTSP_SOURCE_' + SLOT;
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
    expect(sampler.resolveSource(SLOT)).toEqual({ configured: false });
    process.env[ENV_KEY] = SENTINEL;
    const resolved = sampler.resolveSource(SLOT);
    expect(resolved).toEqual({ configured: true });
    expect(JSON.stringify(resolved)).not.toContain(SENTINEL);
  });

  it('missing configuration fails safely with RTSP_SOURCE_NOT_CONFIGURED (no spawn)', async () => {
    const sampler = buildSampler();
    const result = await sampler.sampleFrame(SLOT, {
      width: 4,
      height: 4,
      timeoutMs: 2000,
    });
    expect(result).toEqual({ ok: false, code: 'RTSP_SOURCE_NOT_CONFIGURED' });
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  it('a malformed slot name resolves to not-configured (no env interpolation risk)', async () => {
    const sampler = buildSampler();
    const result = await sampler.sampleFrame('not a slot!', {
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
    const pending = sampler.sampleFrame(SLOT, {
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
    const pending = sampler.sampleFrame(SLOT, {
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
    const pending = sampler.sampleFrame(SLOT, {
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
    const pending = sampler.sampleFrame(SLOT, {
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
      const pending = sampler.sampleFrame(SLOT, {
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
    const pending = sampler.sampleFrame(SLOT, {
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

  it('exports exactly the controlled error-code vocabulary', () => {
    expect([...RTSP_SAMPLE_ERROR_CODES].sort()).toEqual(
      [
        'RTSP_CONNECT_FAILED',
        'RTSP_FRAME_SAMPLE_FAILED',
        'RTSP_SOURCE_NOT_CONFIGURED',
        'RTSP_TIMEOUT',
        'RTSP_UNSUPPORTED_IN_ENV',
      ].sort(),
    );
  });
});
