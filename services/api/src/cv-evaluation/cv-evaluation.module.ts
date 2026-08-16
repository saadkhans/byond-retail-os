import { Module } from '@nestjs/common';
import { PlatformModulesModule } from '../platform-modules/platform-modules.module';
import { CvEvaluationController } from './cv-evaluation.controller';
import { CvEvaluationService } from './cv-evaluation.service';

/** Phase 11 CV evaluation — read-only metrics over ground truth and
 *  fusion shadow runs; writes nothing (see shadow-mode.spec.ts). */
@Module({
  imports: [PlatformModulesModule],
  controllers: [CvEvaluationController],
  providers: [CvEvaluationService],
})
export class CvEvaluationModule {}
