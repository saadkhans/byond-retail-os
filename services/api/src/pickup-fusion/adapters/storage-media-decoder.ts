import { Injectable } from '@nestjs/common';
import { PickupAnalysisFrameDecoder } from '../../pickup-detection/analysis/analysis-frames';
import {
  AnalysisFrame,
  AnalysisGeometry,
} from '../../pickup-detection/analysis/pickup-analyzer';
import { RgbImage } from '../../pickup-detection/analysis/product-matcher';
import { LocalVideoStorageAdapter } from '../../video-ingest/storage/local-video-storage.adapter';
import { PickupMediaDecoder } from '../ports';

/**
 * PickupMediaDecoder over LOCAL storage: composes the local storage
 * adapter (the ONLY place a storage key becomes a filesystem path —
 * internalPathFor is a local-adapter extension, not part of the storage
 * port) with the confined ffmpeg rawvideo decoder. The fusion service
 * consumes the port alone, so an object-store deployment swaps this
 * binding for an adapter that downloads by key — no service change.
 */
@Injectable()
export class LocalStorageMediaDecoder implements PickupMediaDecoder {
  readonly adapterKey = 'ffmpeg-rawvideo';
  readonly version = '1.0.0';

  constructor(
    private readonly storage: LocalVideoStorageAdapter,
    private readonly decoder: PickupAnalysisFrameDecoder,
  ) {}

  /** The decode itself probes ffmpeg and fails CLASSIFIED (the shared
   *  extraction error types) — there is no cheaper readiness signal. */
  checkReady(): Promise<boolean> {
    return Promise.resolve(true);
  }

  decodeAnalysisFrames(
    storageKey: string,
    fps: number,
    geometry: AnalysisGeometry,
    durationMs: number,
  ): Promise<AnalysisFrame[]> {
    return this.decoder.decodeAnalysisFrames(
      this.storage.internalPathFor(storageKey),
      fps,
      geometry,
      durationMs,
    );
  }

  decodeFrameAt(
    storageKey: string,
    timestampMs: number,
    geometry: AnalysisGeometry,
  ): Promise<AnalysisFrame> {
    return this.decoder.decodeFrameAt(
      this.storage.internalPathFor(storageKey),
      timestampMs,
      geometry,
    );
  }

  decodeReferenceImage(storageKey: string): Promise<RgbImage> {
    return this.decoder.decodeReferenceImage(
      this.storage.internalPathFor(storageKey),
    );
  }
}
