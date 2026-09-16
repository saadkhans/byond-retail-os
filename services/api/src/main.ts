import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { parseCorsOrigins, parseTrustProxy } from './config/env.validation';
import { UPLOAD_ATTESTATION_HEADERS } from './video-ingest/test-media-gate.guard';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // req.ip (used by the login throttle) honors X-Forwarded-For only when the
  // deployment explicitly opts in via TRUST_PROXY. Default: never trusted.
  const config = app.get(ConfigService);
  app.set('trust proxy', parseTrustProxy(config.get<string>('TRUST_PROXY')));

  // Browser clients (admin web) live on a different origin. Only the origins
  // listed in CORS_ORIGINS are allowed — no wildcard, no credentials (auth
  // is a Bearer header, not cookies). Default: the local Vite dev server.
  app.enableCors({
    origin: parseCorsOrigins(config.get<string>('CORS_ORIGINS')),
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
    // The test-media upload gate reads its attestation headers BEFORE the
    // body is buffered; the browser therefore preflights them, and they
    // must be allowed here or the upload never leaves the browser.
    allowedHeaders: [
      'Authorization',
      'Content-Type',
      ...UPLOAD_ATTESTATION_HEADERS.map(({ header }) => header),
    ],
    maxAge: 600,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const nodeEnv = config.get<string>('NODE_ENV') ?? 'development';

  if (nodeEnv !== 'production') {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('BYOND Core Platform API')
      .setDescription(
        'Core platform — auth, tenants, users, RBAC, stores, modules, ' +
          'product catalog, inventory, retail units, devices, checkout ' +
          'sessions, orders, and payments; versioned pricing, the ' +
          'autonomous store loop, returns/refunds/reconciliation, ' +
          'electronic shelf labels, loyalty and promotions, procurement, ' +
          'read-only reporting, the CV inference and video-ingest ' +
          'foundations, and the public shopper surface. ' +
          'Payments remain PROVIDER-NEUTRAL: there is NO live payment ' +
          'gateway, NO provider ' +
          'SDK, and NO raw card data — authorization, capture and refund are ' +
          'SIMULATED through an internal state machine, provider references ' +
          'are opaque, and an order is marked PAID only when its payment ' +
          'intent reaches the CAPTURED state. Real gateway adapters and ' +
          'webhook signature verification arrive in a later phase. ' +
          'All endpoints except /health, /auth/login, /edge/register, and ' +
          'the /shopper surface require an Authorization: Bearer <access ' +
          'token> header (POST /auth/login). The /shopper routes (Phase 35) ' +
          'authenticate a SHOPPER instead of a user: the single-use store ' +
          'entry credential, presented as Authorization: Shopper <secret>, ' +
          'which authorizes exactly one journey in exactly one tenant and ' +
          'nothing else. It is the ONLY public surface in this API that ' +
          'returns tenant data, it names no tenant, store, journey or ' +
          'shopper in any request (every identifier is read off the ' +
          'credential server-side), and it accepts NO payment data of any ' +
          'kind. ' +
          'Errors use the standard Nest shape: { statusCode, message, error }.',
      )
      .setVersion('1.0.0')
      .addTag(
        'stores',
        'Tenant stores/branches/sites (the Location entity): name, code, ' +
          'type, status, timezone, address. Served under both /stores and ' +
          '/locations; the GET list differs — /locations returns the ' +
          'legacy plain array, /stores a filtered/paginated envelope.',
      )
      .addTag(
        'catalog',
        'Tenant product catalog: categories, brands, products/SKUs, barcodes.',
      )
      .addTag(
        'inventory',
        'Stock levels per tenant/location/product, the append-only ' +
          'movement ledger, and manual stock adjustments.',
      )
      .addTag(
        'units',
        'Autonomous retail units (smart fridges, shelves, kiosks, ...) ' +
          'assigned to stores, with a DRAFT → ACTIVE → MAINTENANCE/' +
          'DISABLED → RETIRED lifecycle.',
      )
      .addTag(
        'devices',
        'Devices (cameras, locks, sensors, gateways, ...) attached to ' +
          'retail units: per-tenant unique serials, heartbeats, lastSeenAt, ' +
          'firmware/software versions, and safe non-secret metadata.',
      )
      .addTag(
        'checkout-sessions',
        'Tenant checkout sessions on a store/unit with basket lines and a ' +
          'OPEN → ACTIVE ↔ PENDING_REVIEW → COMPLETED/CANCELLED/EXPIRED ' +
          'lifecycle. Completion atomically creates a CONFIRMED order and ' +
          'consumes inventory via SALE ledger movements (idempotent by ' +
          'key). Evidence/source fields (sourceType, visionEventId, ' +
          'vlmReviewId, ...) are vendor-neutral and are now populated for ' +
          'real by the store loop, which bridges approved vision events ' +
          'onto basket lines. A line locks the price resolved when it was ' +
          'added, so a price activation mid-shop never re-prices an open ' +
          'basket.',
      )
      .addTag(
        'orders',
        'Orders generated from completed checkout sessions: per-tenant ' +
          'order numbers, immutable product snapshot lines with full ' +
          'session → line → movement lineage. CONFIRMED means inventory ' +
          'was consumed — NOT paid/captured; an order is PAID only when a ' +
          'linked payment intent reaches CAPTURED. Pricing fields are no ' +
          'longer placeholders: where a price book resolves every line, the ' +
          'order carries a total derived from the price each line was added ' +
          'at, and that total is the authority on what may be charged. An ' +
          'order whose lines cannot all be priced is created with a null ' +
          'total and is payable by hand.',
      )
      .addTag(
        'payments',
        'Provider-neutral payment intents with a CREATED → ' +
          'REQUIRES_AUTHORIZATION → AUTHORIZED → CAPTURE_PENDING → CAPTURED ' +
          'lifecycle (plus FAILED/CANCELLED/VOIDED/EXPIRED). NO live gateway: ' +
          'authorization and capture are SIMULATED and provider references ' +
          'are opaque. Only SAFE card metadata (brand, last4, expiry, wallet) ' +
          'is stored — never raw PAN/CVV/PIN/track data, tokens, or secrets. ' +
          'A captured intent is the ONLY thing that marks a linked order PAID; ' +
          'duplicate captures are idempotent and never move money twice.',
      )
      .addTag(
        'payment-events',
        'Provider event / webhook INGESTION FOUNDATION (authenticated/' +
          'admin-only, not a public webhook). Only normalized fields are ' +
          'stored — no raw provider payload, no signature verification yet. ' +
          'Duplicate (provider, providerEventId) is idempotent.',
      )
      .addTag(
        'reconciliation',
        'Reconciliation FOUNDATION: read models plus a manual status update. ' +
          'A PENDING record is seeded on capture. NO settlement accounting, ' +
          'NO provider reconciliation import, NO Zoho integration in this ' +
          'phase.',
      )
      .addTag(
        'inference',
        'Provider-neutral CV inference jobs (Phase 9): QUEUED → RUNNING → ' +
          'SUCCEEDED/FAILED lifecycle over a database-backed queue ' +
          '(priority DESC, requestedAt ASC — deterministic), a SIMULATED ' +
          'adapter only (no real model execution, no runtime ML/video ' +
          'dependency), append-only results with ranked SKU candidates, ' +
          'and a one-shot idempotent conversion of successful results into ' +
          'Phase 7 vision events (PENDING_REVIEW; never touches the ' +
          'basket). Jobs carry SAFE input descriptors only — no raw media, ' +
          'no storage keys or signed URLs, no credentials.',
      )
      .addTag(
        'edge-registration',
        'Safe device/edge registration foundation: an admin issues a ' +
          'one-time, expiring, serial-bound token (only its SHA-256 hash ' +
          'is stored); the edge device redeems it at /edge/register. This ' +
          'is how a real node in services/edge-runtime is provisioned: it ' +
          'seals itself to the tenant, location and device the redeemed ' +
          'token names and refuses to start against any other.',
      )
      .addTag(
        'pricing',
        'Versioned price books and their entries (/price-books) plus ' +
          'resolution (/prices/resolve). A price is a row in a VERSION, ' +
          'never a field on a product: changing a price publishes a new ' +
          'version and rollback copies an earlier version forward, so ' +
          'history is never rewritten. Store-scoped books beat tenant-wide ' +
          'ones. No tax, no scheduled activation worker, no import/export.',
      )
      .addTag(
        'store-flow',
        'The autonomous store loop: versioned autonomy policy, single-use ' +
          'entry credentials, the observation → basket bridge, one review ' +
          'queue, and exit into an order and a payment. The DEFAULT policy ' +
          'is SHADOW — observe only, change nothing — so enabling the ' +
          'module alters no behavior until a tenant opts in. Every step is ' +
          'idempotent; a journey with anything awaiting review will not ' +
          'settle.',
      )
      .addTag(
        'shopper',
        'The PUBLIC shopper surface (three routes, one principal). ' +
          'Authenticated by Authorization: Shopper <secret> — the ' +
          'single-use store entry credential — which authorizes exactly ' +
          'one journey in exactly one tenant. No tenant, store, journey or ' +
          'shopper id is ever accepted from the client, and no payment ' +
          'data of any kind is accepted or returned.',
      )
      .addTag(
        'returns',
        'The reverse flow: customer returns, cancellation of a settled ' +
          'order, and refunds bounded by what was actually captured and ' +
          'idempotent on retry. Goods go back through the append-only ' +
          'ledger; damaged goods are refunded without being restocked, and ' +
          'the record says so. The refund gateway is SIMULATED only.',
      )
      .addTag(
        'cycle-counts',
        'Stocktakes and cycle counts. A count shows the counted figure, ' +
          'the stored projection and a full ledger replay side by side; ' +
          'only the difference is written, and a count that agrees writes ' +
          'nothing. Projection-vs-ledger disagreement is reported as a ' +
          'PLATFORM DEFECT, never folded into operator variance.',
      )
      .addTag(
        'shrink',
        'Write-offs for CV-detected loss. Bounded by what was actually ' +
          'observed, once per observation, behind its own permission — ' +
          'nothing automatic reaches this route, because a write-off ' +
          'removes real stock.',
      )
      .addTag(
        'esl',
        'Vendor-neutral electronic shelf labels: gateways, label ' +
          'discovery and binding, an update queue and a reconcile pass. ' +
          'Activating a price version queues a push to every bound label. ' +
          'Delivery is BEST-EFFORT by design — an unreachable label must ' +
          'never fail a price change. The only shipped adapter is ' +
          'SIMULATED; queue passes are operator-driven, not a background ' +
          'worker.',
      )
      .addTag(
        'loyalty',
        'Member accounts with an append-only points ledger, and versioned ' +
          'promotions that compose ON TOP of the price version in force ' +
          'without ever rewriting it. GET /loyalty/quote names the price ' +
          'version AND the promotion version behind any price. Promotions ' +
          'do NOT stack: exactly one applies, the largest discount.',
      )
      .addTag(
        'procurement',
        'Suppliers, supplier costs, purchase orders and goods receipts. ' +
          'Receiving writes the same append-only inventory ledger a sale ' +
          'does, so stock and ledger history cannot disagree. Purchase ' +
          'cost and retail price are separate. No returns to supplier, no ' +
          'landed cost, no automatic reordering, one currency per order.',
      )
      .addTag(
        'reporting',
        'READ-ONLY reports derived on read — sales explained down to the ' +
          'price and promotion version, inventory movements and balances, ' +
          'count reconciliation, shrink, and CV accuracy as COUNTS ONLY ' +
          '(no evidence, clips or crops). No roll-up tables, no cache, no ' +
          'scheduled job and no Prisma model of its own, so reporting can ' +
          'never become a second set of books. Every route needs ' +
          'report:read AND the permission guarding the underlying rows.',
      )
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('docs', app, document);
  }

  await app.listen(config.get<number>('PORT') ?? 3000);
}

void bootstrap();
