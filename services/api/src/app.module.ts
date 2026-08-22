import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AccessControlModule } from './access-control/access-control.module';
import { AuthModule } from './auth/auth.module';
import { CameraModule } from './camera/camera.module';
import { CatalogModule } from './catalog/catalog.module';
import { CheckoutModule } from './checkout/checkout.module';
import { RequestIdMiddleware } from './common/request-id.middleware';
import { CvDatasetModule } from './cv-dataset/cv-dataset.module';
import { CvEvaluationModule } from './cv-evaluation/cv-evaluation.module';
import { validateEnv } from './config/env.validation';
import { DevicesModule } from './devices/devices.module';
import { HealthModule } from './health/health.module';
import { InferenceModule } from './inference/inference.module';
import { InventoryModule } from './inventory/inventory.module';
import { JourneyModule } from './journey/journey.module';
import { LocationsModule } from './locations/locations.module';
import { OrdersModule } from './orders/orders.module';
import { PaymentsModule } from './payments/payments.module';
import { PilotEvaluationModule } from './pilot-evaluation/pilot-evaluation.module';
import { PlatformModulesModule } from './platform-modules/platform-modules.module';
import { PickupDetectionModule } from './pickup-detection/pickup-detection.module';
import { PickupFusionModule } from './pickup-fusion/pickup-fusion.module';
import { PrismaModule } from './prisma/prisma.module';
import { TenantsModule } from './tenants/tenants.module';
import { UnitsModule } from './units/units.module';
import { UsersModule } from './users/users.module';
import { VideoIngestModule } from './video-ingest/video-ingest.module';
import { VisionModule } from './vision/vision.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    PrismaModule,
    AuthModule,
    HealthModule,
    TenantsModule,
    UsersModule,
    AccessControlModule,
    LocationsModule,
    PlatformModulesModule,
    CatalogModule,
    InventoryModule,
    UnitsModule,
    DevicesModule,
    CheckoutModule,
    OrdersModule,
    PaymentsModule,
    VisionModule,
    InferenceModule,
    VideoIngestModule,
    PickupDetectionModule,
    PickupFusionModule,
    CvEvaluationModule,
    JourneyModule,
    CameraModule,
    PilotEvaluationModule,
    CvDatasetModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*path');
  }
}
