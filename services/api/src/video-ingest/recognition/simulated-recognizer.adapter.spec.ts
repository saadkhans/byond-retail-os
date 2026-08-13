import { execFile, spawn } from 'node:child_process';
import { SimulatedFrameTextRecognizer } from './simulated-recognizer.adapter';

// This adapter has NO tooling: the module is mocked purely so the specs can
// ASSERT that nothing is ever spawned — including by the readiness check.
jest.mock('node:child_process', () => ({
  execFile: jest.fn(),
  spawn: jest.fn(),
}));

const execFileMock = execFile as unknown as jest.Mock;
const spawnMock = spawn as unknown as jest.Mock;

describe('SimulatedFrameTextRecognizer', () => {
  it('honestly declares it never reads the pixels', () => {
    // The pre-storage frame screen must REFUSE to treat this adapter's
    // empty result as a pass — readsRealPixels=false is the discriminator
    // the upload availability gate keys on.
    const recognizer = new SimulatedFrameTextRecognizer();
    expect(recognizer.readsRealPixels).toBe(false);
    expect(recognizer.kind).toBe('simulated');
  });

  it('reports tooling READY trivially, without invoking anything', async () => {
    // No binary, no child process, nothing that can fail to run. Reporting
    // ready OPENS NOTHING: the pre-buffer upload gate refuses on
    // readsRealPixels=false above, and readiness is only the second half of
    // that gate (does the tool the capability flag promises actually run?),
    // never a substitute for it.
    const recognizer = new SimulatedFrameTextRecognizer();
    const ready = await recognizer.checkToolingReady();
    expect(typeof ready).toBe('boolean');
    expect(ready).toBe(true);
    expect(execFileMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('recognizes nothing, deterministically, without touching the buffer', async () => {
    const recognizer = new SimulatedFrameTextRecognizer();
    await expect(recognizer.recognize(Buffer.from('anything'))).resolves.toBe(
      '',
    );
    await expect(recognizer.recognize(Buffer.alloc(0))).resolves.toBe('');
  });
});
