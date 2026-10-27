import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module.js';
import { MatchingModule } from '../matching/matching.module.js';
import { MediaModule } from '../media/media.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { ReviewsModule } from '../reviews/reviews.module.js';
import { SchedulingModule } from '../scheduling/scheduling.module.js';
import { WorkersModule } from '../workers/workers.module.js';
import { DirectBookingService } from './direct-booking.service.js';
import { JobEventsService } from './job-events.service.js';
import { JobExpiryService } from './job-expiry.service.js';
import { NoShowService } from './no-show.service.js';
import { JobViewService } from './job-view.service.js';
import { CustomerJobsController, JobsController } from './jobs.controller.js';
import { JobsService } from './jobs.service.js';
import { WorkerBackOutService } from './worker-backout.service.js';
import { WorkerCancellationsController } from './worker-cancellations.controller.js';
import { WorkerCancellationsService } from './worker-cancellations.service.js';

@Module({
  imports: [
    CatalogModule,
    MediaModule,
    MatchingModule,
    NotificationsModule,
    WorkersModule,
    SchedulingModule,
    ReviewsModule,
  ],
  controllers: [
    JobsController,
    CustomerJobsController,
    WorkerCancellationsController,
  ],
  providers: [
    JobsService,
    DirectBookingService,
    JobExpiryService,
    NoShowService,
    JobEventsService,
    JobViewService,
    WorkerBackOutService,
    WorkerCancellationsService,
  ],
  exports: [JobEventsService, JobViewService, JobsService],
})
export class JobsModule {}
