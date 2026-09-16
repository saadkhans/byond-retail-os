import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { sealedIdentity, temporaryStore } from '../../test/helpers';
import { LOGS } from '../store/store-names';
import { ConfigurationService } from './configuration.service';

/**
 * The sync protocol must never become a second source of truth for stock.
 *
 * ARCHITECTURE.md: stock is never a mutable number; every movement is an
 * append-only ledger fact and every level is a projection over it. An edge node
 * PROPOSES and the cloud VALIDATES — so configuration arriving from the cloud
 * may replace the catalog, the planogram or a price, and may not move a single
 * unit of stock. Today that holds because nothing in `src/sync` can reach the
 * ledger; this pins it so a later phase cannot quietly wire one in.
 */
describe('sync is not an authority on stock', () => {
  const syncDir = __dirname;

  const collectSources = (dir: string): string[] => {
    const files: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        files.push(...collectSources(full));
      } else if (full.endsWith('.ts') && !full.endsWith('.spec.ts')) {
        files.push(full);
      }
    }
    return files;
  };

  const sources = collectSources(syncDir);

  it.each(sources.map((file) => [relative(syncDir, file)]))(
    'keeps %s away from the ledger',
    (file) => {
      const source = readFileSync(join(syncDir, file), 'utf8');
      expect(source).not.toContain('LocalLedgerService');
      expect(source).not.toContain('LOGS.ledger');
      expect(source).not.toContain('ledger.types');
    },
  );

  it('does not let a cloud configuration entry write the ledger', async () => {
    const context = await temporaryStore();
    try {
      const configuration = new ConfigurationService(
        context.store,
        await sealedIdentity(context.store),
      );
      // A hostile or buggy control plane publishing something stock-shaped.
      await configuration.apply([
        {
          resourceType: 'PRODUCT',
          resourceId: 'sku-water',
          version: 1,
          payload: { quantity: 99, quantityDelta: 99, stock: 99 },
        },
      ]);
      await expect(context.store.count(LOGS.ledger)).resolves.toBe(0);
    } finally {
      await context.cleanup();
    }
  });
});
