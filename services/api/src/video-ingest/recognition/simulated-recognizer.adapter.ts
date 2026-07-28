import { Injectable } from '@nestjs/common';
import { FrameTextRecognizerPort } from './frame-text-recognizer.port';

export const SIMULATED_RECOGNIZER_KIND = 'simulated';

/**
 * The default Phase 10 frame-text recognizer: NO OCR tooling, no child
 * processes, no npm dependency. It deterministically recognizes NOTHING —
 * and honestly declares readsRealPixels=false, so the pre-storage frame
 * screen refuses to treat its empty result as a pass (an upload screened
 * by an adapter that never looked at the pixels would be a blind pass).
 * Dev/test flows that need uploads without real tooling opt in explicitly
 * via VIDEO_UNSAFE_ALLOW_UNSCREENED_UPLOADS instead.
 */
@Injectable()
export class SimulatedFrameTextRecognizer extends FrameTextRecognizerPort {
  readonly kind = SIMULATED_RECOGNIZER_KIND;

  // Placeholder result, NOT the frame's text: pixel-screening surfaces
  // must refuse to rely on this adapter.
  readonly readsRealPixels = false;

  recognize(frame: Buffer): Promise<string> {
    // The buffer is unused except to keep the contract honest — a
    // simulated recognizer never reads the pixels.
    void frame;
    return Promise.resolve('');
  }
}
