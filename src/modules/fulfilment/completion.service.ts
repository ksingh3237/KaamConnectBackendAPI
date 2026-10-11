import { Injectable } from '@nestjs/common';
import { JobStatus } from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { JobEventsService } from '../jobs/job-events.service.js';
import {
  JobViewService,
  jobInclude,
  type JobView,
} from '../jobs/job-view.service.js';
import { transition } from '../jobs/state/job-state-machine.js';
import { explainFailedClaim, jobNotFound } from './job-access.js';

/**
 * The worker says the work is done: IN_PROGRESS -> WORK_COMPLETED. From this moment the database no
 * longer counts the job as holding the worker's calendar (only payment is pending), so the worker is
 * free: we tell their app to send a fresh location (`location.refresh`, docs BR-21).
 */
@Injectable()
export class CompletionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: JobEventsService,
    private readonly views: JobViewService,
  ) {}

  async complete(workerId: string, jobId: string): Promise<JobView> {
    const job = await this.prisma.job.findFirst({
      where: { id: jobId, workerId },
      select: { status: true },
    });
    if (!job) throw jobNotFound();
    transition('COMPLETE_WORK', job.status);

    const claimed = await this.prisma.job.updateMany({
      where: { id: jobId, workerId, status: JobStatus.IN_PROGRESS },
      data: { status: JobStatus.WORK_COMPLETED, workCompletedAt: new Date() },
    });
    if (claimed.count !== 1)
      await explainFailedClaim(this.prisma, jobId, { workerId });

    const done = await this.prisma.job.findUniqueOrThrow({
      where: { id: jobId },
      include: jobInclude,
    });
    this.events.statusChanged(done);
    this.events.workerFreed(workerId, jobId);
    return this.views.forWorker(done, workerId);
  }
}
