import { Injectable } from '@nestjs/common';
import { JobStatus, LeadResponse } from '../../generated/prisma/enums.js';
import { MatchingService, spotOfJob } from '../matching/matching.service.js';
import {
  RealtimeEvent,
  type ArrivalCodeResetPayload,
  type BillUpdatedPayload,
  type BookingConfirmedPayload,
  type JobLocationPayload,
  type JobReopenedPayload,
  type JobStatusPayload,
  type LeadClosedPayload,
  type LocationRefreshPayload,
} from '../realtime/events.js';
import { RealtimePublisher } from '../realtime/realtime-publisher.js';
import { LeadDeliveryService } from '../scheduling/lead-delivery.service.js';
import { leadPayloadOf, type JobRow } from './job-view.service.js';

interface Participants {
  id: string;
  status: JobStatus;
  customerId: string;
  workerId: string | null;
  targetWorkerId: string | null;
}

/**
 * Every push the job lifecycle sends, in one place, so the privacy rules (who hears what, and which
 * fields are in the payload) are reviewed together. Call these only AFTER the transaction commits.
 */
@Injectable()
export class JobEventsService {
  constructor(
    private readonly publisher: RealtimePublisher,
    private readonly matching: MatchingService,
    private readonly deliveries: LeadDeliveryService,
  ) {}

  /** `job.status` to the customer and whichever worker is involved (assigned, else the requested one). */
  statusChanged(job: Participants, at: Date = new Date()): void {
    const payload: JobStatusPayload = {
      jobId: job.id,
      status: job.status,
      at: at.toISOString(),
    };
    this.publisher.toUser(job.customerId, RealtimeEvent.JOB_STATUS, payload);
    const worker = job.workerId ?? job.targetWorkerId;
    if (worker)
      this.publisher.toUser(worker, RealtimeEvent.JOB_STATUS, payload);
  }

  /**
   * A new broadcast job: `lead.new` to every verified worker who offers the trade and serves the
   * spot. A busy worker is told like anyone else (BR-1); each worker is told once (BR-22).
   */
  async leadOpened(job: JobRow): Promise<number> {
    const covering = await this.matching.findCoveringWorkers({
      categoryId: job.categoryId,
      customerId: job.customerId,
      spot: spotOfJob(job),
    });
    const fresh = new Set(
      await this.deliveries.claim(
        job.id,
        covering.map((w) => w.workerId),
      ),
    );
    for (const worker of covering) {
      if (!fresh.has(worker.workerId)) continue;
      this.publisher.toUser(
        worker.workerId,
        RealtimeEvent.LEAD_NEW,
        leadPayloadOf(job, worker.distanceKm, false),
      );
    }
    return covering.length;
  }

  /** A direct booking: `direct.request` to the one worker asked, nobody else. */
  async directRequested(job: JobRow, targetWorkerId: string): Promise<void> {
    const coverage = await this.matching.coverageForWorker(
      targetWorkerId,
      spotOfJob(job),
    );
    const fresh = await this.deliveries.claim(job.id, [targetWorkerId]);
    if (fresh.length === 0) return;
    this.publisher.toUser(
      targetWorkerId,
      RealtimeEvent.DIRECT_REQUEST,
      leadPayloadOf(job, coverage?.distanceKm ?? null, true),
    );
  }

  /** The requested worker said no: the customer should pick someone else. */
  directDeclined(job: Participants): void {
    this.publisher.toUser(job.customerId, RealtimeEvent.DIRECT_DECLINED, {
      jobId: job.id,
    });
  }

  /** Nobody answered the direct request in time. */
  directExpired(job: Participants): void {
    this.publisher.toUser(job.customerId, RealtimeEvent.DIRECT_EXPIRED, {
      jobId: job.id,
    });
  }

  /**
   * The lead is gone (assigned, cancelled, expired): tell the workers who could see it so it leaves
   * their radar. `except` skips workers who already got a more specific message; workers who
   * declined the lead already hid it, so they are not told.
   */
  async leadClosed(
    job: JobRow,
    reason: LeadClosedPayload['reason'],
    except: readonly string[] = [],
  ): Promise<void> {
    const payload: LeadClosedPayload = { id: job.id, reason };
    const delivered = await this.deliveries.recipientsOf(job.id);
    const recipients = new Set<string>();
    if (job.targetWorkerId) {
      recipients.add(job.targetWorkerId);
    } else {
      const covering = await this.matching.findCoveringWorkers({
        categoryId: job.categoryId,
        customerId: job.customerId,
        spot: spotOfJob(job),
      });
      for (const w of covering) recipients.add(w.workerId);
      // Also everyone it was actually sent to, even if they have since moved out of range.
      for (const r of delivered) recipients.add(r.workerId);
    }
    const declined = new Set(
      delivered
        .filter((r) => r.response === LeadResponse.DECLINED)
        .map((r) => r.workerId),
    );
    for (const workerId of recipients) {
      if (!except.includes(workerId) && !declined.has(workerId))
        this.publisher.toUser(workerId, RealtimeEvent.LEAD_CLOSED, payload);
    }
  }

  /** The booking is final: tells the customer and the worker which window is reserved. */
  bookingConfirmed(job: {
    id: string;
    customerId: string;
    workerId: string | null;
    bookedStartAt: Date | null;
    bookedEndAt: Date | null;
    bookingConfirmedAt: Date | null;
  }): void {
    if (!job.workerId || !job.bookedStartAt || !job.bookedEndAt) return;
    const payload: BookingConfirmedPayload = {
      jobId: job.id,
      startAt: job.bookedStartAt.toISOString(),
      endAt: job.bookedEndAt.toISOString(),
      confirmedAt: (job.bookingConfirmedAt ?? new Date()).toISOString(),
    };
    this.publisher.toUser(
      job.customerId,
      RealtimeEvent.BOOKING_CONFIRMED,
      payload,
    );
    this.publisher.toUser(
      job.workerId,
      RealtimeEvent.BOOKING_CONFIRMED,
      payload,
    );
  }

  /**
   * The worker is free again (job finished or cancelled). Their last fix is probably at the customer's
   * door, so ask the app for a fresh one; the next location update re-runs lead matching (BR-21).
   */
  /** The itemised bill changed: tells the customer to re-fetch it. */
  billUpdated(customerId: string, jobId: string, total: number): void {
    const payload: BillUpdatedPayload = { jobId, total };
    this.publisher.toUser(customerId, RealtimeEvent.BILL_UPDATED, payload);
  }

  /** The assigned worker backed out: the customer's request is open for quotes again. */
  jobReopened(customerId: string, jobId: string): void {
    const payload: JobReopenedPayload = { jobId, reason: 'WORKER_BACKED_OUT' };
    this.publisher.toUser(customerId, RealtimeEvent.JOB_REOPENED, payload);
  }

  /** The customer issued a new arrival code: tells the worker to ask for it (the code itself is never pushed). */
  arrivalCodeReset(workerId: string, jobId: string): void {
    const payload: ArrivalCodeResetPayload = { jobId };
    this.publisher.toUser(workerId, RealtimeEvent.ARRIVAL_CODE_RESET, payload);
  }

  /** Live position of the worker on the way, to whoever is watching the job (the `job:watch` room). */
  jobLocation(payload: JobLocationPayload): void {
    this.publisher.toJob(payload.jobId, RealtimeEvent.JOB_LOCATION, payload);
  }

  workerFreed(workerId: string, jobId: string): void {
    const payload: LocationRefreshPayload = { reason: 'JOB_ENDED', jobId };
    this.publisher.toUser(workerId, RealtimeEvent.LOCATION_REFRESH, payload);
  }
}
