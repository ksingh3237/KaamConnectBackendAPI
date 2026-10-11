import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module.js';
import { MatchingModule } from '../matching/matching.module.js';
import { MediaModule } from '../media/media.module.js';
import { ReviewsModule } from '../reviews/reviews.module.js';
import { DiscoveryController } from './discovery/discovery.controller.js';
import { DiscoveryService } from './discovery/discovery.service.js';
import { WorkerCardService } from './worker-card.service.js';
import {
  WorkerVerificationService,
  verificationModeProvider,
} from './worker-verification.service.js';
import { WorkersController } from './workers.controller.js';
import { WorkersService } from './workers.service.js';

@Module({
  imports: [CatalogModule, MediaModule, MatchingModule, ReviewsModule],
  // Order matters: WorkersController owns `workers/me`, which must match before `workers/:id`.
  controllers: [WorkersController, DiscoveryController],
  providers: [
    WorkersService,
    WorkerVerificationService,
    verificationModeProvider,
    WorkerCardService,
    DiscoveryService,
  ],
  exports: [WorkersService, WorkerVerificationService, WorkerCardService],
})
export class WorkersModule {}
