import { Controller, Get } from '@nestjs/common';
import { PipelineService } from '../pipeline/pipeline.service';
import { PipelineMetrics } from '../pipeline/metrics';

/**
 * The operational surface. Two endpoints, both unauthenticated, both
 * deliberately incapable of disclosing anything.
 *
 * The API's health controller sets the precedent and the reason: health
 * endpoints get scraped by things that hold no credentials, so the
 * payload carries no versions, no dependency names, no environment, and
 * no error text. This one adds counters, which are safe for the same
 * reason the API's performance metrics are — they are numbers and values
 * from closed vocabularies, so the worst a reader learns is how busy a
 * camera is.
 */
@Controller()
export class HealthController {
  constructor(private readonly pipeline: PipelineService) {}

  @Get('health')
  check(): { status: 'ok'; tracking: 'running' | 'stopped' } {
    return {
      status: 'ok',
      tracking: this.pipeline.metricsSnapshot().running
        ? 'running'
        : 'stopped',
    };
  }

  @Get('metrics')
  metrics(): PipelineMetrics {
    return this.pipeline.metricsSnapshot();
  }
}
