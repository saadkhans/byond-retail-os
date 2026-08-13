/**
 * Local-dev harness: run pickup-fusion-v2 (SHADOW) for one asset exactly
 * as POST /video-assets/:id/fusion-run would, then print the VLM evidence
 * block and before/after mutation counters (orders, payments, checkout
 * sessions, inventory movements) to prove shadow mode holds.
 *
 * Usage: from services/api —
 *   npx ts-node -T scripts/fusion-shadow-run.ts <tenantId> <videoAssetId>
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { PickupFusionService } from '../src/pickup-fusion/pickup-fusion.service';
import { PrismaService } from '../src/prisma/prisma.service';

async function main() {
  const [tenantId, videoAssetId] = process.argv.slice(2);
  if (!tenantId || !videoAssetId) {
    console.error('usage: fusion-shadow-run.ts <tenantId> <videoAssetId>');
    process.exit(1);
  }
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  try {
    const prisma = app.get(PrismaService);
    const fusion = app.get(PickupFusionService);

    const counters = async () => ({
      orders: await prisma.order.count(),
      paymentIntents: await prisma.paymentIntent.count(),
      checkoutSessions: await prisma.checkoutSession.count(),
      inventoryMovements: await prisma.inventoryMovement.count(),
    });

    const before = await counters();
    console.log('READINESS:', JSON.stringify(await fusion.vlmReadiness()));
    const { runId } = await fusion.run(tenantId, videoAssetId);
    const after = await counters();

    const latest = await fusion.latestEvidence(tenantId, videoAssetId);
    console.log('RUN_ID:', runId);
    console.log('POLICY:', JSON.stringify(latest?.evidence.policy));
    console.log('VLM:', JSON.stringify(latest?.evidence.vlm, null, 2));
    console.log('SHADOW:', JSON.stringify(latest?.evidence.shadow, null, 2));
    console.log('MUTATION_CHECK before:', JSON.stringify(before));
    console.log('MUTATION_CHECK after :', JSON.stringify(after));
  } finally {
    await app.close();
  }
}

void main();
