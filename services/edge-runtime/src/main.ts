import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { EdgeConfigService } from './config/edge-config.service';
import { StructuredLogger } from './logging/structured-logger';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const logger = app.get(StructuredLogger);
  app.useLogger(logger);
  app.enableShutdownHooks();

  const config = app.get(EdgeConfigService);
  // Loopback by default: the metrics snapshot describes the store's state.
  await app.listen(config.opsPort, config.opsBindAddress);
  logger.detail(
    'info',
    'edge runtime started',
    { port: config.opsPort, bind: config.opsBindAddress },
    'bootstrap',
  );
}

void bootstrap();
