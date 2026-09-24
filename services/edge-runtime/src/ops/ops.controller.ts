import { Controller, Get, Inject } from '@nestjs/common';
import { EDGE_STORE, EdgeStorePort } from '../store/edge-store.port';
import { EdgeMetrics, MetricsService } from './metrics.service';

/**
 * Health is deliberately minimal — no versions, dependency names or error
 * detail — matching the cloud API's health endpoint. The metrics snapshot is
 * richer, which is why the ops server binds to loopback by default.
 */
@Controller()
export class OpsController {
  constructor(
    @Inject(EDGE_STORE) private readonly store: EdgeStorePort,
    private readonly metrics: MetricsService,
  ) {}

  @Get('health')
  async health(): Promise<{
    status: 'ok';
    store: 'up' | 'down';
    cloud: 'online' | 'offline';
  }> {
    const store = (await this.store.checkReady()) ? 'up' : 'down';
    const snapshot = await this.metrics.snapshot();
    return {
      status: 'ok',
      store,
      cloud: snapshot.connectivity === 'ONLINE' ? 'online' : 'offline',
    };
  }

  @Get('metrics')
  async snapshot(): Promise<EdgeMetrics> {
    return this.metrics.snapshot();
  }
}
