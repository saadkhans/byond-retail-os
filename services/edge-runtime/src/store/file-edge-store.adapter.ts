import { createHash } from 'node:crypto';
import {
  appendFile,
  mkdir,
  open as openFile,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { assertPersistable } from '../logging/redaction';
import {
  EdgeStorePort,
  LoggedEntry,
  StoredRecord,
} from './edge-store.port';

const RECORDS_DIR = 'records';
const LOGS_DIR = 'logs';
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * File-backed durable store.
 *
 * Durability choices, and why:
 * - A record is written to a temporary file and renamed into place. Rename is
 *   atomic within a volume, so a crash leaves either the old record or the new
 *   one, never a half-written one.
 * - A log entry is one JSON object per line, appended and fsynced. A crash
 *   mid-append can leave a torn final line; readers skip a trailing line that
 *   does not parse, which is what makes replay-after-crash safe. Sequences are
 *   assigned from the last READABLE entry, so a torn line is re-used rather
 *   than leaving a permanent hole.
 * - Ids are hashed into filenames. Ids come from the cloud and from device
 *   payloads; hashing removes every path-traversal and case-collision question
 *   instead of trying to sanitise them.
 */
export class FileEdgeStore implements EdgeStorePort {
  readonly adapterKey = 'file';
  readonly version = '1.0.0';

  private readonly sequences = new Map<string, number>();
  private readonly appendChains = new Map<string, Promise<unknown>>();
  private opened = false;

  constructor(private readonly root: string) {}

  async checkReady(): Promise<boolean> {
    try {
      await mkdir(this.root, { recursive: true });
      return true;
    } catch {
      return false;
    }
  }

  async open(): Promise<void> {
    await mkdir(join(this.root, RECORDS_DIR), { recursive: true });
    await mkdir(join(this.root, LOGS_DIR), { recursive: true });
    this.sequences.clear();
    let logFiles: string[] = [];
    try {
      logFiles = await readdir(join(this.root, LOGS_DIR));
    } catch {
      logFiles = [];
    }
    for (const file of logFiles) {
      if (!file.endsWith('.jsonl')) {
        continue;
      }
      const log = file.slice(0, -'.jsonl'.length);
      const entries = await this.readAll<unknown>(log);
      const last = entries.length === 0 ? 0 : entries[entries.length - 1].sequence;
      this.sequences.set(log, last);
    }
    this.opened = true;
  }

  private assertOpen(): void {
    if (!this.opened) {
      throw new Error('FileEdgeStore.open() must run before use');
    }
  }

  private static assertName(name: string, what: string): void {
    if (!NAME_PATTERN.test(name)) {
      throw new Error(`Invalid ${what} name`);
    }
  }

  private recordPath(collection: string, id: string): string {
    FileEdgeStore.assertName(collection, 'collection');
    const hashed = createHash('sha256').update(id).digest('hex').slice(0, 40);
    return join(this.root, RECORDS_DIR, collection, `${hashed}.json`);
  }

  private logPath(log: string): string {
    FileEdgeStore.assertName(log, 'log');
    return join(this.root, LOGS_DIR, `${log}.jsonl`);
  }

  async get<T>(collection: string, id: string): Promise<T | null> {
    this.assertOpen();
    try {
      const raw = await readFile(this.recordPath(collection, id), 'utf8');
      const parsed = JSON.parse(raw) as StoredRecord<T>;
      return parsed.value;
    } catch {
      return null;
    }
  }

  async put<T>(collection: string, id: string, value: T): Promise<void> {
    this.assertOpen();
    assertPersistable(value, `edge store put ${collection}`);
    const path = this.recordPath(collection, id);
    await mkdir(join(this.root, RECORDS_DIR, collection), { recursive: true });
    const payload = JSON.stringify({ id, value } satisfies StoredRecord<T>);
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, payload, 'utf8');
    await rename(temporary, path);
  }

  async remove(collection: string, id: string): Promise<void> {
    this.assertOpen();
    await rm(this.recordPath(collection, id), { force: true });
  }

  async list<T>(collection: string): Promise<ReadonlyArray<StoredRecord<T>>> {
    this.assertOpen();
    FileEdgeStore.assertName(collection, 'collection');
    const directory = join(this.root, RECORDS_DIR, collection);
    let files: string[];
    try {
      files = await readdir(directory);
    } catch {
      return [];
    }
    const records: StoredRecord<T>[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) {
        continue;
      }
      try {
        const raw = await readFile(join(directory, file), 'utf8');
        records.push(JSON.parse(raw) as StoredRecord<T>);
      } catch {
        // A torn record is skipped: the writer renames into place, so a
        // partial file can only be a leftover temporary.
      }
    }
    return records.sort((left, right) => left.id.localeCompare(right.id));
  }

  async append<T>(log: string, entry: T): Promise<number> {
    this.assertOpen();
    assertPersistable(entry, `edge store append ${log}`);
    // Appends to one log are serialised so two callers cannot claim the same
    // sequence. Different logs proceed independently.
    const chained = (this.appendChains.get(log) ?? Promise.resolve()).then(
      () => this.appendNow(log, entry),
      () => this.appendNow(log, entry),
    );
    this.appendChains.set(
      log,
      chained.catch(() => undefined),
    );
    return chained;
  }

  private async appendNow<T>(log: string, entry: T): Promise<number> {
    const path = this.logPath(log);
    const sequence = (this.sequences.get(log) ?? 0) + 1;
    // A crash mid-append leaves a line with no terminator. Starting a fresh
    // line before writing keeps that torn remnant self-contained, so it stays
    // the only unreadable entry instead of swallowing the next one too.
    const terminated = await this.endsWithNewline(path);
    const line = `${terminated ? '' : '\n'}${JSON.stringify({ sequence, entry })}\n`;
    await mkdir(join(this.root, LOGS_DIR), { recursive: true });
    await appendFile(path, line, 'utf8');
    const handle = await openFile(path, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    this.sequences.set(log, sequence);
    return sequence;
  }

  /** True when the file is absent, empty, or already ends in a newline. */
  private async endsWithNewline(path: string): Promise<boolean> {
    let handle: Awaited<ReturnType<typeof openFile>>;
    try {
      handle = await openFile(path, 'r');
    } catch {
      return true;
    }
    try {
      const { size } = await handle.stat();
      if (size === 0) {
        return true;
      }
      const buffer = Buffer.alloc(1);
      await handle.read(buffer, 0, 1, size - 1);
      return buffer[0] === 0x0a;
    } finally {
      await handle.close();
    }
  }

  private async readAll<T>(log: string): Promise<LoggedEntry<T>[]> {
    let raw: string;
    try {
      raw = await readFile(this.logPath(log), 'utf8');
    } catch {
      return [];
    }
    const entries: LoggedEntry<T>[] = [];
    for (const line of raw.split('\n')) {
      if (line === '') {
        continue;
      }
      try {
        const parsed = JSON.parse(line) as LoggedEntry<T>;
        if (typeof parsed.sequence === 'number') {
          entries.push(parsed);
        }
      } catch {
        // Torn trailing line from a crash mid-append. Skipping it is the
        // recovery: its sequence is handed to the next writer.
      }
    }
    return entries;
  }

  async read<T>(
    log: string,
    afterSequence: number,
    limit: number,
  ): Promise<ReadonlyArray<LoggedEntry<T>>> {
    this.assertOpen();
    const entries = await this.readAll<T>(log);
    return entries
      .filter((entry) => entry.sequence > afterSequence)
      .slice(0, limit);
  }

  async lastSequence(log: string): Promise<number> {
    this.assertOpen();
    return this.sequences.get(log) ?? 0;
  }

  async count(log: string): Promise<number> {
    this.assertOpen();
    const entries = await this.readAll<unknown>(log);
    return entries.length;
  }
}
