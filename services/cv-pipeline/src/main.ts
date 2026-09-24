import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule, PIPELINE_CONFIG } from './app.module';
import { PipelineConfig } from './config/pipeline.config';

/**
 * Entry point. The tracking loop starts itself on application bootstrap;
 * the HTTP server exists only for health and metrics.
 *
 * It binds to the loopback interface by default. This service holds an
 * API bearer token and watches a camera, and nothing about it needs to be
 * reachable from a store network — a deployment that wants it exposed
 * puts a reverse proxy in front and makes that an explicit decision.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: false });
  app.enableShutdownHooks();

  const config = app.get<PipelineConfig>(PIPELINE_CONFIG);
  await app.listen(config.port, '127.0.0.1');

  new Logger('Bootstrap').log(
    `CV pipeline listening on 127.0.0.1:${config.port}`,
  );
}

void bootstrap();
