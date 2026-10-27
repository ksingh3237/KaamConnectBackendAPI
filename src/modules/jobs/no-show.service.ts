import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { EnvVars } from '../../config/env.validation.js';
import { JobStatus } from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { JobEventsService } from './job-events.service.js';
import { jobInclude } from './job-view.service.js';
import { WorkerBackOutService } from './worker-backout.service.js';

/** How many jobs one run handles; the next minute picks up the rest. */
const BATCH = 200;

export interface NoShowRun {
  warned: number;
  released: number;
}

/**
 * Worker no-show (docs/15-no-show.md). A job that is ASSIGNED has a promised arrival, `booked_start_at` (the worker's
 * quoted ETA from the moment the customer accepted, or the appointment time). Once that time has passed:
 *  1. the customer and the worker are told once that the worker is late;
 *  2. NO_SHOW_GRACE_MIN later, if the worker still has not arrived, the job is released: re-opened for new quotes (a
 *     broadcast job) or closed (a direct booking), the worker's slot is freed, and it is recorded as a no-show that
 *     counts against the worker.
 * The worker's GPS is deliberately not consulted: a phone that cannot be tracked must not decide this.
 * Safe on several instances: every step is a conditional update that exactly one instance wins.
 */
@Injectable()
export class NoShowService {
  private readonly logger = new Logger(NoShowService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<EnvVars, true>,
    private readonly events: JobEventsService,
    private readonly backOut: WorkerBackOutService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async scheduled(): Promise<void> {
    try {
      const run = await this.sweep();
      if (run.warned > 0 || run.released > 0)
        this.logger.log(
          `No-show sweep: ${run.warned} warned, ${run.released} released`,
        );
    } catch (error) {
      this.logger.error(
        `No-show sweep failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async sweep(now: Date = new Date()): Promise<NoShowRun> {
    const released = await this.releaseOverdue(now);
    const warned = await this.warnLate(now);
    return { warned, released };
  }

  private graceMs(): number {
    return this.config.get('NO_SHOW_GRACE_MIN', { infer: true }) * 60_000;
  }

  private async releaseOverdue(now: Date): Promise<number> {
    const due = await this.prisma.job.findMany({
      where: {
        status: JobStatus.ASSIGNED,
        workerId: { not: null },
        bookedStartAt: { lte: new Date(now.getTime() - this.graceMs()) },
      },
      select: { id: true },
      orderBy: { bookedStartAt: 'asc' },
      take: BATCH,
    });
    let released = 0;
    for (const { id } of due) {
      try {
        if (await this.backOut.releaseNoShow(id, now)) released += 1;
      } catch (error) {
        // One bad job must not stop the others; the next run retries it.
        this.logger.error(
          `Releasing job ${id} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return released;
  }

  private async warnLate(now: Date): Promise<number> {
    const late = await this.prisma.job.findMany({
      where: {
        status: JobStatus.ASSIGNED,
        workerId: { not: null },
        bookedStartAt: { lte: now },
        lateNotifiedAt: null,
      },
      select: { id: true },
      orderBy: { bookedStartAt: 'asc' },
      take: BATCH,
    });
    let warned = 0;
    for (const { id } of late) {
      // Claim it first so two instances (or two runs) never send the notices twice.
      const claimed = await this.prisma.job.updateMany({
        where: {
          id,
          status: JobStatus.ASSIGNED,
          bookedStartAt: { lte: now },
          lateNotifiedAt: null,
        },
        data: { lateNotifiedAt: now },
      });
      if (claimed.count !== 1) continue;
      const job = await this.prisma.job.findUnique({
        where: { id },
        include: jobInclude,
      });
      if (!job?.workerId || !job.bookedStartAt) continue;
      this.events.workerLate(
        job,
        job.workerId,
        new Date(job.bookedStartAt.getTime() + this.graceMs()),
      );
      warned += 1;
    }
    return warned;
  }
}
