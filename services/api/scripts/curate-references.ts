/**
 * One-off local-dev curation of the reference library (not for CI):
 *   1. remove reference images that are placeholders (tiny files) for a product,
 *   2. add the given image files as new references,
 *   3. rebuild the CLIP reference index.
 *
 * Usage (from services/api):
 *   npx ts-node -T scripts/curate-references.ts --tenant <id> --sku <SKU> \
 *      [--prune-below-bytes 8192] [--add <file> ...] [--dry-run]
 */
import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { ReferenceImagesService } from '../src/pickup-detection/reference-images.service';
import { PickupFusionService } from '../src/pickup-fusion/pickup-fusion.service';
import { PrismaService } from '../src/prisma/prisma.service';

function arg(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}
function args(flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < process.argv.length; i += 1) {
    if (process.argv[i] === flag && process.argv[i + 1]) out.push(process.argv[i + 1]);
  }
  return out;
}

async function main(): Promise<void> {
  const tenantId = arg('--tenant');
  const sku = arg('--sku');
  if (!tenantId || !sku) throw new Error('--tenant and --sku are required');
  const pruneBelow = Number(arg('--prune-below-bytes') ?? '8192');
  const adds = args('--add');
  const dryRun = process.argv.includes('--dry-run');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const prisma = app.get(PrismaService);
    const references = app.get(ReferenceImagesService);
    const fusion = app.get(PickupFusionService);
    const product = await prisma.product.findFirst({ where: { tenantId, sku } });
    if (!product) throw new Error(`no product ${sku} in tenant ${tenantId}`);
    const rows = await prisma.productReferenceImage.findMany({
      where: { tenantId, productId: product.id },
      orderBy: { createdAt: 'asc' },
    });
    console.log(`${sku}: ${rows.length} references before`);
    for (const row of rows) {
      if (row.sizeBytes < pruneBelow) {
        console.log(`  prune ${row.originalFilename} (${row.sizeBytes} B)`);
        if (!dryRun) await references.remove(tenantId, product.id, row.id);
      }
    }
    for (const file of adds) {
      const ext = extname(file).toLowerCase();
      const mimetype = ext === '.png' ? 'image/png' : 'image/jpeg';
      console.log(`  add ${basename(file)}`);
      if (!dryRun) {
        await references.upload(tenantId, product.id, {
          buffer: readFileSync(file),
          mimetype,
          originalname: basename(file),
        });
      }
    }
    const after = await prisma.productReferenceImage.count({
      where: { tenantId, productId: product.id },
    });
    console.log(`${sku}: ${after} references after`);
    if (!dryRun) {
      const result = await fusion.reindexReferenceIndex(tenantId, true);
      console.log('reindex:', JSON.stringify(result));
    }
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
