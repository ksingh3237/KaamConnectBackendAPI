import { Module } from '@nestjs/common';
import { JobsModule } from '../jobs/jobs.module.js';
import { MediaModule } from '../media/media.module.js';
import { SchedulingModule } from '../scheduling/scheduling.module.js';
import { WorkersModule } from '../workers/workers.module.js';
import {
  JobOffersController,
  LeadsController,
  OffersController,
} from './offers.controller.js';
import { LeadCatchUpService } from './lead-catch-up.service.js';
import { LeadsService } from './leads.service.js';
import { OffersService } from './offers.service.js';

@Module({
  imports: [JobsModule, MediaModule, WorkersModule, SchedulingModule],
  controllers: [LeadsController, OffersController, JobOffersController],
  providers: [LeadsService, OffersService, LeadCatchUpService],
})
export class OffersModule {}
