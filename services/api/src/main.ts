import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { parseCorsOrigins, parseTrustProxy } from './config/env.validation';

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
    allowedHeaders: ['Authorization', 'Content-Type'],
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
          'product catalog, inventory, retail units, and devices. ' +
          'All endpoints except /health, /auth/login, and /edge/register ' +
          'require an Authorization: Bearer <access token> header ' +
          '(POST /auth/login). ' +
          'Errors use the standard Nest shape: { statusCode, message, error }.',
      )
      .setVersion('0.4.0')
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
