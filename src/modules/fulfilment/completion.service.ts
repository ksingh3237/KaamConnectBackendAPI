import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/exceptions/app.exception.js';
import { JobMediaKind, JobStatus } from '../../generated/prisma/enums.js';
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
 *
 * Proof of work is compulsory: at least one "before" and one "after" photo must be on the job first.
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

    // Photos can never be removed, so counting before the claim below cannot race with anything.
    const [before, after] = await Promise.all(
      [JobMediaKind.BEFORE_PHOTO, JobMediaKind.AFTER_PHOTO].map((kind) =>
        this.prisma.jobMedia.count({ where: { jobId, kind } }),
      ),
    );
    if (before === 0 || after === 0) {
      throw new AppException(
        'WORK_PHOTOS_REQUIRED',
        409,
        'Add at least one before photo and one after photo before marking the work complete',
      );
    }

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
