import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module.js';
import { MatchingModule } from '../matching/matching.module.js';
import { MediaModule } from '../media/media.module.js';
import { ReviewsModule } from '../reviews/reviews.module.js';
import { SchedulingModule } from '../scheduling/scheduling.module.js';
import { WorkersModule } from '../workers/workers.module.js';
import { DirectBookingService } from './direct-booking.service.js';
import { JobEventsService } from './job-events.service.js';
import { JobExpiryService } from './job-expiry.service.js';
import { JobViewService } from './job-view.service.js';
import { CustomerJobsController, JobsController } from './jobs.controller.js';
import { JobsService } from './jobs.service.js';
import { WorkerBackOutService } from './worker-backout.service.js';

@Module({
  imports: [
    CatalogModule,
    MediaModule,
    MatchingModule,
    WorkersModule,
    SchedulingModule,
    ReviewsModule,
  ],
  controllers: [JobsController, CustomerJobsController],
  providers: [
    JobsService,
    DirectBookingService,
    JobExpiryService,
    JobEventsService,
    JobViewService,
    WorkerBackOutService,
  ],
  exports: [JobEventsService, JobViewService, JobsService],
})
export class JobsModule {}
