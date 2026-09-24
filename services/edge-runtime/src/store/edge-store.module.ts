import { Global, Module } from '@nestjs/common';
import { EdgeConfigService } from '../config/edge-config.service';
import { EDGE_STORE, EdgeStorePort } from './edge-store.port';
import { FileEdgeStore } from './file-edge-store.adapter';

@Global()
@Module({
  providers: [
    {
      provide: EDGE_STORE,
      inject: [EdgeConfigService],
      useFactory: async (config: EdgeConfigService): Promise<EdgeStorePort> => {
        const store = new FileEdgeStore(config.storeRoot);
        await store.open();
        return store;
      },
    },
  ],
  exports: [EDGE_STORE],
})
export class EdgeStoreModule {}
