/**
 * Local-dev evaluation harness: re-run pickup-fusion-v2 (SHADOW) over a set
 * of GROUND-TRUTHED video assets exactly as POST /video-assets/:id/fusion-run
 * would, then print one row per clip comparing the run against its ground
 * truth (event verification, fused top SKU, policy, shadow verdict) and the
 * totals. Read-only apart from the PickupFusionRun evidence rows the runs
 * create — no vision events, no inventory writes.
 *
 * Usage: from services/api —
 *   npx ts-node -T scripts/replay-fusion.ts --tenant <id> --since <ISO> [--prefix r1_] [--offset N] [--limit N]
 *   npx ts-node -T scripts/replay-fusion.ts --tenant <id> --asset <id> [--asset <id> ...]
 */
import { NestFactory } from '@nestjs/core';
import { VideoAssetStatus } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PickupFusionService } from '../src/pickup-fusion/pickup-fusion.service';
import { PrismaService } from '../src/prisma/prisma.service';

interface Args {
  tenant: string | null;
  since: string | null;
  prefix: string | null;
  limit: number | null;
  offset: number | null;
  assets: string[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = { tenant: null, since: null, prefix: null, limit: null, offset: null, assets: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--tenant') {
      args.tenant = value ?? null;
      i += 1;
    } else if (flag === '--since') {
      args.since = value ?? null;
      i += 1;
    } else if (flag === '--prefix') {
      args.prefix = value ?? null;
      i += 1;
    } else if (flag === '--limit') {
      args.limit = Number(value);
      i += 1;
    } else if (flag === '--offset') {
      args.offset = Number(value);
      i += 1;
    } else if (flag === '--asset') {
      if (value) args.assets.push(value);
      i += 1;
    }
  }
  return args;
}

function pad(value: unknown, width: number): string {
  const text = value === null || value === undefined ? '-' : String(value);
  return text.length >= width ? text.slice(0, width) : text.padEnd(width);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.tenant || (args.assets.length === 0 && !args.since)) {
    console.error(
      'usage: replay-fusion.ts --tenant <id> (--since <ISO> [--prefix <name-prefix>] [--limit N] | --asset <id> ...)',
    );
    process.exit(1);
  }
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const prisma = app.get(PrismaService);
    const fusion = app.get(PickupFusionService);

    const assets = await prisma.videoAsset.findMany({
      where: {
        tenantId: args.tenant,
        deletedAt: null,
        status: { in: [VideoAssetStatus.VALIDATED, VideoAssetStatus.READY] },
        groundTruth: { isNot: null },
        ...(args.assets.length > 0 ? { id: { in: args.assets } } : {}),
        ...(args.since ? { createdAt: { gte: new Date(args.since) } } : {}),
        ...(args.prefix ? { originalFilename: { startsWith: args.prefix } } : {}),
      },
      orderBy: { originalFilename: 'asc' },
      ...(args.limit && Number.isFinite(args.limit) ? { take: args.limit } : {}),
      ...(args.offset && Number.isFinite(args.offset) ? { skip: args.offset } : {}),
      select: {
        id: true,
        originalFilename: true,
        groundTruth: {
          select: { eventKind: true, product: { select: { sku: true } } },
        },
      },
    });
    console.log(`READINESS: ${JSON.stringify(await fusion.vlmReadiness())}`);
    console.log(`${assets.length} ground-truthed asset(s) to replay\n`);
    const header =
      `${pad('file', 32)} ${pad('gt', 7)} ${pad('gtSku', 19)} ${pad('check', 8)} ${pad('cnt', 6)} ` +
      `${pad('conf', 5)} ${pad('fusedTop', 19)} ${pad('policy', 19)} ${pad('v2', 14)} ${pad('s', 4)}`;
    console.log(header);
    const totals = {
      events: { total: 0, correct: 0, wrong: 0, missed: 0 },
      noEvent: { total: 0, trueNegative: 0, falsePickup: 0 },
      checks: { verdict: 0, touchOnly: 0, recovered: 0, notRun: 0, failed: 0 },
    };
    for (const asset of assets) {
      const startedAt = Date.now();
      let line: string;
      try {
        await fusion.run(args.tenant, asset.id);
        const latest = await fusion.latestEvidence(args.tenant, asset.id);
        const evidence = latest?.evidence;
        const check = evidence?.eventVerification;
        const v2 = evidence?.shadow.v2Verdict ?? null;
        const gtKind = asset.groundTruth?.eventKind ?? '-';
        const warnings = evidence?.detector.warnings ?? [];
        if (check?.status === 'VERDICT') totals.checks.verdict += 1;
        else if (check?.status === 'NOT_RUN' || !check) totals.checks.notRun += 1;
        else totals.checks.failed += 1;
        if (warnings.includes('TOUCH_ONLY')) totals.checks.touchOnly += 1;
        if (warnings.includes('EVENT_FROM_VLM_COUNT')) totals.checks.recovered += 1;
        if (gtKind === 'NONE') {
          totals.noEvent.total += 1;
          if (v2 === 'true_negative') totals.noEvent.trueNegative += 1;
          else totals.noEvent.falsePickup += 1;
        } else {
          totals.events.total += 1;
          if (v2 === 'correct') totals.events.correct += 1;
          else if (v2 === 'missed') totals.events.missed += 1;
          else totals.events.wrong += 1;
        }
        line =
          `${pad(asset.originalFilename, 32)} ${pad(gtKind, 7)} ${pad(asset.groundTruth?.product?.sku ?? '-', 19)} ` +
          `${pad(check?.change ?? check?.status ?? '-', 8)} ${pad(check?.before !== null && check?.before !== undefined ? `${check.before}->${check.after}` : '-', 6)} ` +
          `${pad(check?.confidence ?? '-', 5)} ${pad(latest?.fusedTopSku ?? '-', 19)} ${pad(latest?.policy ?? '-', 19)} ` +
          `${pad(v2, 14)} ${pad(Math.round((Date.now() - startedAt) / 1000), 4)}`;
      } catch (error) {
        line = `${pad(asset.originalFilename, 32)} RUN FAILED: ${error instanceof Error ? error.message : 'unknown'}`;
      }
      console.log(line);
    }
    console.log('\nTOTALS');
    console.log(
      `  event clips ${totals.events.total}: correct ${totals.events.correct}, wrong SKU ${totals.events.wrong}, missed ${totals.events.missed}`,
    );
    console.log(
      `  no-event clips ${totals.noEvent.total}: true negative ${totals.noEvent.trueNegative}, false pickup ${totals.noEvent.falsePickup}`,
    );
    console.log(
      `  event checks: verdict ${totals.checks.verdict}, not run ${totals.checks.notRun}, failed ${totals.checks.failed}; ` +
        `touch-only ${totals.checks.touchOnly}, recovered ${totals.checks.recovered}`,
    );
  } finally {
    await app.close();
  }
}

void main();
