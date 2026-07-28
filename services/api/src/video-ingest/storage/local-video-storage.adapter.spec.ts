import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { VideoStorageOperationError } from './video-storage.port';
import {
  InvalidStorageKeyError,
  LocalVideoStorageAdapter,
} from './local-video-storage.adapter';

function adapterFor(root: string): LocalVideoStorageAdapter {
  const config = {
    get: (key: string) => (key === 'VIDEO_STORAGE_ROOT' ? root : undefined),
  } as unknown as ConfigService;
  return new LocalVideoStorageAdapter(config);
}

describe('LocalVideoStorageAdapter', () => {
  let root: string;
  let adapter: LocalVideoStorageAdapter;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'byond-video-storage-'));
    adapter = adapterFor(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('round-trips bytes under the configured root', async () => {
    const key = 'tenant-1/asset-1/original.mp4';
    await adapter.put(key, Buffer.from('test-bytes'));
    expect((await adapter.read(key)).toString('utf8')).toBe('test-bytes');
    // The resolved path stays inside the root.
    expect(adapter.internalPathFor(key).startsWith(resolve(root) + sep)).toBe(
      true,
    );
    // Atomic temp-file publish leaves NO temp artifacts behind — the
    // directory contains exactly the published object.
    expect(readdirSync(join(root, 'tenant-1', 'asset-1'))).toEqual([
      'original.mp4',
    ]);
  });

  it.each([
    ['../escape.mp4'],
    ['tenant/../../escape.mp4'],
    ['..'],
    ['/absolute/path.mp4'],
    ['C:/windows/path.mp4'],
    ['C:\\windows\\path.mp4'],
    ['tenant\\asset\\original.mp4'],
    ['.hidden'],
    [''],
    ['tenant/asset/$(rm -rf).mp4'],
    ['tenant/asset/sp ace.mp4'],
  ])('rejects key %p before any filesystem call', async (key) => {
    await expect(adapter.put(key, Buffer.alloc(1))).rejects.toBeInstanceOf(
      InvalidStorageKeyError,
    );
    await expect(adapter.read(key)).rejects.toBeInstanceOf(
      InvalidStorageKeyError,
    );
    expect(() => adapter.internalPathFor(key)).toThrow(InvalidStorageKeyError);
  });

  it('never echoes the key or the root in the rejection', () => {
    let caught: Error | undefined;
    try {
      adapter.internalPathFor('../secret-probe');
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toBeInstanceOf(InvalidStorageKeyError);
    expect(caught?.message).not.toContain('secret-probe');
    expect(caught?.message).not.toContain(root);
  });

  it('delete is idempotent (missing objects are a no-op)', async () => {
    await expect(
      adapter.delete('tenant-1/asset-1/missing.mp4'),
    ).resolves.toBeUndefined();
  });

  it('maps filesystem failures to a controlled error that never carries a path', async () => {
    // Reading a key that does not exist surfaces a raw ENOENT from the fs
    // layer — whose message embeds the absolute resolved path. The adapter
    // must swallow it into the generic, path-free storage error.
    let caught: Error | undefined;
    try {
      await adapter.read('tenant-1/asset-1/missing.mp4');
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toBeInstanceOf(VideoStorageOperationError);
    expect(caught?.message).toBe('Video storage operation failed');
    expect(caught?.message).not.toContain(root);
    expect(caught?.message).not.toContain('missing.mp4');
  });

  it('deletePrefix removes an asset directory but refuses the root itself', async () => {
    await adapter.put('tenant-1/asset-1/original.mp4', Buffer.alloc(4));
    await adapter.put('tenant-1/asset-1/artifacts/a.png', Buffer.alloc(4));
    // Reports that something existed and was removed by THIS call…
    await expect(adapter.deletePrefix('tenant-1/asset-1')).resolves.toBe(true);
    await expect(adapter.read('tenant-1/asset-1/original.mp4')).rejects.toThrow();
    // …and that an idempotent replay found nothing (callers use this to
    // record a media-removal completion exactly once).
    await expect(adapter.deletePrefix('tenant-1/asset-1')).resolves.toBe(false);
    await expect(adapter.deletePrefix('.')).rejects.toBeInstanceOf(
      InvalidStorageKeyError,
    );
  });
});
