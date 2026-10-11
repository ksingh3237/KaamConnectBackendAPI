import { Module } from '@nestjs/common';
import { JobsModule } from '../jobs/jobs.module.js';
import { MediaModule } from '../media/media.module.js';
import { WorkersModule } from '../workers/workers.module.js';
import { ArrivalService } from './arrival.service.js';
import { BillService } from './bill.service.js';
import { CompletionService } from './completion.service.js';
import {
  FulfilmentController,
  WorkerJobsController,
} from './fulfilment.controller.js';
import { PaymentService } from './payment.service.js';
import { TrackingService } from './tracking.service.js';
import { WorkerJobsService } from './worker-jobs.service.js';

/** Phase 5: arrival, bill, completion, payment, receipt, live tracking and the worker's job list. */
@Module({
  imports: [JobsModule, MediaModule, WorkersModule],
  controllers: [FulfilmentController, WorkerJobsController],
  providers: [
    ArrivalService,
    BillService,
    CompletionService,
    PaymentService,
    TrackingService,
    WorkerJobsService,
  ],
})
export class FulfilmentModule {}
