import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryStore } from '../../test/helpers';
import { FileEdgeStore } from './file-edge-store.adapter';

describe('FileEdgeStore', () => {
  let context: Awaited<ReturnType<typeof temporaryStore>>;

  beforeEach(async () => {
    context = await temporaryStore();
  });

  afterEach(async () => {
    await context.cleanup();
  });

  it('round-trips a record and survives reopening', async () => {
    await context.store.put('configuration', 'PRODUCT:sku-1', { name: 'Water' });
    const reopened = new FileEdgeStore(context.root);
    await reopened.open();
    await expect(reopened.get('configuration', 'PRODUCT:sku-1')).resolves.toEqual({
      name: 'Water',
    });
  });

  it('returns null for an unknown record rather than throwing', async () => {
    await expect(context.store.get('configuration', 'nope')).resolves.toBeNull();
  });

  it('lists a collection and removes a record', async () => {
    await context.store.put('review', 'b', { n: 2 });
    await context.store.put('review', 'a', { n: 1 });
    await expect(context.store.list('review')).resolves.toHaveLength(2);
    await context.store.remove('review', 'a');
    await expect(context.store.list('review')).resolves.toHaveLength(1);
  });

  it('assigns monotonic sequences per log, independently', async () => {
    await expect(context.store.append('ledger', { a: 1 })).resolves.toBe(1);
    await expect(context.store.append('ledger', { a: 2 })).resolves.toBe(2);
    await expect(context.store.append('outbox', { b: 1 })).resolves.toBe(1);
  });

  it('serialises concurrent appends so no sequence is reused', async () => {
    const sequences = await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        context.store.append('ledger', { index }),
      ),
    );
    expect(new Set(sequences).size).toBe(25);
    expect([...sequences].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 25 }, (_, index) => index + 1),
    );
  });

  it('continues sequences after a restart', async () => {
    await context.store.append('ledger', { a: 1 });
    await context.store.append('ledger', { a: 2 });
    const reopened = new FileEdgeStore(context.root);
    await reopened.open();
    await expect(reopened.lastSequence('ledger')).resolves.toBe(2);
    await expect(reopened.append('ledger', { a: 3 })).resolves.toBe(3);
  });

  it('recovers from a torn final line written by a crash mid-append', async () => {
    await context.store.append('ledger', { a: 1 });
    const path = join(context.root, 'logs', 'ledger.jsonl');
    // Simulate a process killed part-way through writing its line.
    await appendFile(path, '{"sequence":2,"entry":{"a":2', 'utf8');

    const reopened = new FileEdgeStore(context.root);
    await reopened.open();
    // The torn entry is not readable, so its sequence is handed to the next
    // writer rather than leaving a permanent hole.
    await expect(reopened.count('ledger')).resolves.toBe(1);
    await expect(reopened.append('ledger', { a: 2 })).resolves.toBe(2);
    const entries = await reopened.read<{ a: number }>('ledger', 0, 10);
    expect(entries.map((item) => item.sequence)).toEqual([1, 2]);
  });

  it('reads only entries after a sequence, bounded by the limit', async () => {
    for (let index = 1; index <= 5; index += 1) {
      await context.store.append('ledger', { index });
    }
    const page = await context.store.read<{ index: number }>('ledger', 2, 2);
    expect(page.map((item) => item.sequence)).toEqual([3, 4]);
  });

  it('writes a record atomically, leaving no partial file behind', async () => {
    await context.store.put('configuration', 'PRODUCT:sku-1', { name: 'Water' });
    const directory = join(context.root, 'records', 'configuration');
    const files = await readFile(
      join(directory, (await import('node:fs/promises').then((fs) => fs.readdir(directory)))[0]),
      'utf8',
    );
    expect(JSON.parse(files)).toMatchObject({ value: { name: 'Water' } });
  });

  it('neutralises ids that would otherwise escape the store root', async () => {
    const hostile = '../../../etc/passwd';
    await context.store.put('configuration', hostile, { ok: true });
    await expect(context.store.get('configuration', hostile)).resolves.toEqual({
      ok: true,
    });
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(join(context.root, 'records', 'configuration'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9a-f]{40}\.json$/);
  });

  it('rejects a collection or log name that is not a plain slug', async () => {
    await expect(context.store.get('../escape', 'x')).resolves.toBeNull();
    await expect(context.store.append('../escape', {})).rejects.toThrow(
      /Invalid log name/,
    );
  });

  it('refuses to persist card data, secrets or raw media', async () => {
    await expect(
      context.store.put('configuration', 'x', { token: 'abc' }),
    ).rejects.toThrow(/secret/);
    await expect(
      context.store.append('ledger', { blob: new Uint8Array([1]) }),
    ).rejects.toThrow(/byte buffer/);
  });

  it('refuses use before open()', async () => {
    const unopened = new FileEdgeStore(context.root);
    await expect(unopened.get('configuration', 'x')).rejects.toThrow(/open\(\)/);
  });

  it('skips an unreadable record when listing', async () => {
    await context.store.put('review', 'a', { n: 1 });
    const { readdir } = await import('node:fs/promises');
    const directory = join(context.root, 'records', 'review');
    const [file] = await readdir(directory);
    await writeFile(join(directory, file), '{ not json', 'utf8');
    await expect(context.store.list('review')).resolves.toEqual([]);
  });
});
