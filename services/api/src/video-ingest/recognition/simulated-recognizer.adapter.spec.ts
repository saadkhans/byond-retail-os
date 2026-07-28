import { SimulatedFrameTextRecognizer } from './simulated-recognizer.adapter';

describe('SimulatedFrameTextRecognizer', () => {
  it('honestly declares it never reads the pixels', () => {
    // The pre-storage frame screen must REFUSE to treat this adapter's
    // empty result as a pass — readsRealPixels=false is the discriminator
    // the upload availability gate keys on.
    const recognizer = new SimulatedFrameTextRecognizer();
    expect(recognizer.readsRealPixels).toBe(false);
    expect(recognizer.kind).toBe('simulated');
  });

  it('recognizes nothing, deterministically, without touching the buffer', async () => {
    const recognizer = new SimulatedFrameTextRecognizer();
    await expect(recognizer.recognize(Buffer.from('anything'))).resolves.toBe(
      '',
    );
    await expect(recognizer.recognize(Buffer.alloc(0))).resolves.toBe('');
  });
});
