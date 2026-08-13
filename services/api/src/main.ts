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
          'sessions, orders, and payments. Phase 6 adds a PROVIDER-NEUTRAL ' +
          'payment abstraction: there is NO live payment gateway, NO provider ' +
          'SDK, and NO raw card data — authorization and capture are ' +
          'SIMULATED through an internal state machine, provider references ' +
          'are opaque, and an order is marked PAID only when its payment ' +
          'intent reaches the CAPTURED state. Real gateway adapters and ' +
          'webhook signature verification arrive in a later phase. ' +
          'All endpoints except /health, /auth/login, and /edge/register ' +
          'require an Authorization: Bearer <access token> header ' +
          '(POST /auth/login). ' +
          'Errors use the standard Nest shape: { statusCode, message, error }.',
      )
      .setVersion('0.6.0')
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
          'vlmReviewId, ...) are vendor-neutral placeholders for future ' +
          'CV/VLM adapters — no vision code runs in Phase 5.',
      )
      .addTag(
        'orders',
        'Orders generated from completed checkout sessions: per-tenant ' +
          'order numbers, immutable product snapshot lines with full ' +
          'session → line → movement lineage. CONFIRMED means inventory ' +
          'was consumed — NOT paid/captured; payment capture is a later ' +
          'phase, and pricing fields are null placeholders.',
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
          'is stored); the edge device redeems it at /edge/register. ' +
          'Prepares for the Phase 7 edge runtime.',
      )
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('docs', app, document);
  }

  await app.listen(config.get<number>('PORT') ?? 3000);
}

void bootstrap();
