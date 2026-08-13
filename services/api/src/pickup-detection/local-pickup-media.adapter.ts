import { Injectable } from '@nestjs/common';
import { LocalVideoStorageAdapter } from '../video-ingest/storage/local-video-storage.adapter';
import { PickupAnalysisFrameDecoder } from './analysis/analysis-frames';
import { AnalysisFrame, AnalysisGeometry } from './analysis/pickup-analyzer';
import { RgbImage } from './analysis/product-matcher';
import { PickupMediaPort } from './pickup-media.port';

/**
 * PickupMediaPort over LOCAL storage: composes the local storage adapter
 * (the ONLY place a storage key becomes a filesystem path — internalPathFor
 * is a local-adapter extension, not part of the storage port) with the
 * confined ffmpeg rawvideo decoder. Core services consume the port alone,
 * so an object-store deployment or a replacement decoder swaps this binding
 * in the module — no service change. Same seam the fusion pipeline's
 * LocalStorageMediaDecoder established for v2.
 */
@Injectable()
export class LocalPickupMediaAdapter extends PickupMediaPort {
  constructor(
    private readonly storage: LocalVideoStorageAdapter,
    private readonly decoder: PickupAnalysisFrameDecoder,
  ) {
    super();
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

  decodeReferenceImage(storageKey: string): Promise<RgbImage> {
    return this.decoder.decodeReferenceImage(
      this.storage.internalPathFor(storageKey),
    );
  }
}
