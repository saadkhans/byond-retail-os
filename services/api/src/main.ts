import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { parseTrustProxy } from './config/env.validation';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // req.ip (used by the login throttle) honors X-Forwarded-For only when the
  // deployment explicitly opts in via TRUST_PROXY. Default: never trusted.
  const config = app.get(ConfigService);
  app.set('trust proxy', parseTrustProxy(config.get<string>('TRUST_PROXY')));

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
        'Core platform — auth, tenants, users, RBAC, locations, modules. ' +
          'All endpoints except /health and /auth/login require an ' +
          'Authorization: Bearer <access token> header (POST /auth/login). ' +
          'Errors use the standard Nest shape: { statusCode, message, error }.',
      )
      .setVersion('0.2.0')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('docs', app, document);
  }

  await app.listen(config.get<number>('PORT') ?? 3000);
}

void bootstrap();
