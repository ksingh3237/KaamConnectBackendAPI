import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/exceptions/app.exception.js';
import {
  BillItemKind,
  JobStatus,
  LeadResponse,
  OfferStatus,
} from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { generateArrivalCode } from '../jobs/arrival-code.js';
import { JobEventsService } from '../jobs/job-events.service.js';
import { jobInclude } from '../jobs/job-view.service.js';
import { transition } from '../jobs/state/job-state-machine.js';
import {
  coverageOf,
  spotOfJob,
  workerGeoSelect,
} from '../matching/matching.service.js';
import { RealtimeEvent, type OfferPayload } from '../realtime/events.js';
import {
  AvailabilityService,
  toLeadAvailability,
  type LeadAvailability,
} from '../scheduling/availability.service.js';
import { windowFor } from '../scheduling/booking-window.js';
import { LeadDeliveryService } from '../scheduling/lead-delivery.service.js';
import { scheduleConflict } from '../scheduling/scheduling.errors.js';
import { RealtimePublisher } from '../realtime/realtime-publisher.js';
import {
  WorkerCardService,
  cardInclude,
  ratingAverage,
  type WorkerCard,
} from '../workers/worker-card.service.js';
import type { ReviseOfferDto, SendOfferDto } from './dto/offer.dto.js';
import { toOfferSummary, type OfferSummary } from './offer-views.js';

const notFound = (what: string) =>
  new AppException('NOT_FOUND', 404, `${what} not found`);
const jobNotOpen = () =>
  new AppException('JOB_NOT_OPEN', 409, 'This request is no longer open');
/**
 * A quote that was once accepted by the customer and is now WITHDRAWN means this worker backed out of
 * the job. They may not take it again, or the customer could be let down twice.
 */
const isBackedOut = (
  offer: { status: OfferStatus; acceptedAt: Date | null } | null | undefined,
): boolean =>
  !!offer &&
  offer.status === OfferStatus.WITHDRAWN &&
  offer.acceptedAt !== null;
const backedOut = () =>
  new AppException(
    'BACKED_OUT',
    409,
    'You backed out of this request, so you cannot quote on it again',
  );
const directJob = () =>
  new AppException(
    'DIRECT_JOB',
    409,
    'This request was addressed to one worker; use accept or decline on the request itself',
  );
const offerNotPending = () =>
  new AppException(
    'OFFER_NOT_PENDING',
    409,
    'This quote can no longer be changed',
  );

export interface OfferForCustomer {
  offerId: string;
  visitFee: number;
  etaMinutes: number;
  message: string | null;
  status: OfferStatus;
  createdAt: string;
  /** The quote with the earliest arrival (all quotes tied for it are flagged). */
  isFastest: boolean;
  /**
   * Can this worker still make the time? False when they have since taken a clashing booking; accepting
   * the quote would then fail with 409 WORKER_UNAVAILABLE. Quotes already accepted are always true.
   */
  available: boolean;
  /** When the worker would arrive / start if this quote were accepted now. */
  startsAt: string;
  /** If not available: the earliest time the worker would be free again. */
  nextFreeAt: string | null;
  worker: WorkerCard;
}

export interface AcceptedJob {
  status: JobStatus;
  /** The customer reads this out to the worker on arrival. */
  arrivalCode: string;
  /** The confirmed booking: the window the worker is now reserved for. */
  booking: { startAt: string; endAt: string; confirmedAt: string };
  worker: WorkerCard;
}

/** The worker's answer to a lead, with whether the time works for them. */
export interface LeadAnswer {
  jobId: string;
  state: 'ACCEPTED' | 'DECLINED';
  availability?: LeadAvailability;
}

@Injectable()
export class OffersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: JobEventsService,
    private readonly publisher: RealtimePublisher,
    private readonly cards: WorkerCardService,
    private readonly availability: AvailabilityService,
    private readonly deliveries: LeadDeliveryService,
  ) {}

  /** "Send Direct Quote to Customer": one quote per worker per job. */
  async send(
    workerId: string,
    jobId: string,
    dto: SendOfferDto,
  ): Promise<OfferSummary> {
    const job = await this.visibleLead(workerId, jobId);
    if (job.targetWorkerId !== null) {
      throw new AppException(
        'DIRECT_JOB',
        409,
        'This request was addressed to one worker; use accept or decline',
      );
    }
    if (
      job.status !== JobStatus.OPEN ||
      (job.expiresAt && job.expiresAt.getTime() <= Date.now())
    )
      throw jobNotOpen();

    const offer = await this.prisma.$transaction(async (tx) => {
      // Share-lock the job row while quoting. A simultaneous "accept" needs the exclusive lock, so it
      // waits for this quote to commit and then rejects it, instead of leaving it PENDING on a closed job.
      const open = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM jobs
        WHERE id = ${jobId}::uuid AND status = 'OPEN' AND (expires_at IS NULL OR expires_at > now())
        FOR SHARE`;
      if (open.length === 0) throw jobNotOpen();

      // A worker cannot promise a time they are already booked for (BR-16). Being busy with a job in
      // progress does not stop them quoting jobs they can reach.
      await this.availability.assertWorkerCanTake(
        tx,
        workerId,
        job,
        dto.etaMinutes,
      );

      const existing = await tx.offer.findUnique({
        where: { jobId_workerId: { jobId, workerId } },
      });
      if (isBackedOut(existing)) throw backedOut();
      // A withdrawn quote, or one that lost to a worker who has since backed out of a re-opened request,
      // may be sent again; a live (pending or accepted) one may not.
      if (
        existing &&
        existing.status !== OfferStatus.WITHDRAWN &&
        existing.status !== OfferStatus.REJECTED
      ) {
        throw new AppException(
          'OFFER_EXISTS',
          409,
          'You already sent a quote for this request',
        );
      }
      const data = {
        visitFee: dto.visitFee,
        etaMinutes: dto.etaMinutes,
        message: dto.message || null,
      };
      const saved = existing
        ? await tx.offer.update({
            where: { id: existing.id },
            data: { ...data, status: OfferStatus.PENDING },
          })
        : await tx.offer.create({ data: { jobId, workerId, ...data } });
      // Quoting counts as accepting the lead (BR-18).
      await this.deliveries.respond(jobId, workerId, LeadResponse.ACCEPTED, tx);
      return saved;
    });

    await this.notifyCustomer(
      job.customerId,
      offer,
      workerId,
      RealtimeEvent.OFFER_NEW,
    );
    return toOfferSummary(offer);
  }

  /** Change fee, arrival time or message while the quote is still waiting. */
  async revise(
    workerId: string,
    offerId: string,
    dto: ReviseOfferDto,
  ): Promise<OfferSummary> {
    const offer = await this.prisma.offer.findFirst({
      where: { id: offerId, workerId },
      include: {
        job: { include: { area: { select: { lat: true, lng: true } } } },
      },
    });
    if (!offer) throw notFound('Quote');
    if (offer.status !== OfferStatus.PENDING) throw offerNotPending();
    if (offer.job.status !== JobStatus.OPEN) throw jobNotOpen();
    if (dto.etaMinutes !== undefined)
      await this.availability.assertWorkerCanTake(
        this.prisma,
        workerId,
        offer.job,
        dto.etaMinutes,
      );

    const updated = await this.prisma.offer.updateMany({
      where: { id: offerId, workerId, status: OfferStatus.PENDING },
      data: {
        visitFee: dto.visitFee,
        etaMinutes: dto.etaMinutes,
        message: dto.message,
      },
    });
    if (updated.count !== 1) throw offerNotPending();

    const fresh = await this.prisma.offer.findUniqueOrThrow({
      where: { id: offerId },
    });
    await this.notifyCustomer(
      offer.job.customerId,
      fresh,
      workerId,
      RealtimeEvent.OFFER_UPDATED,
    );
    return toOfferSummary(fresh);
  }

  async withdraw(workerId: string, offerId: string): Promise<void> {
    const offer = await this.prisma.offer.findFirst({
      where: { id: offerId, workerId },
      include: { job: true },
    });
    if (!offer) throw notFound('Quote');

    const updated = await this.prisma.offer.updateMany({
      where: { id: offerId, workerId, status: OfferStatus.PENDING },
      data: { status: OfferStatus.WITHDRAWN },
    });
    if (updated.count !== 1) throw offerNotPending();

    const fresh = await this.prisma.offer.findUniqueOrThrow({
      where: { id: offerId },
    });
    await this.notifyCustomer(
      offer.job.customerId,
      fresh,
      workerId,
      RealtimeEvent.OFFER_UPDATED,
    );
  }

  /** Compare Offers: the live quotes on one of the customer's own jobs. */
  async listForJob(
    customerId: string,
    jobId: string,
    sort: 'fee' | 'eta' = 'fee',
  ): Promise<OfferForCustomer[]> {
    const job = await this.prisma.job.findFirst({
      where: { id: jobId, customerId },
      include: { area: { select: { cityId: true, lat: true, lng: true } } },
    });
    if (!job) throw notFound('Job');

    const offers = await this.prisma.offer.findMany({
      where: {
        jobId,
        status: { in: [OfferStatus.PENDING, OfferStatus.ACCEPTED] },
      },
      include: { worker: { include: cardInclude } },
    });
    const earliest =
      offers.length > 0 ? Math.min(...offers.map((o) => o.etaMinutes)) : 0;

    const spot = spotOfJob(job);
    const now = new Date();
    const items = await Promise.all(
      offers.map(async (o): Promise<OfferForCustomer> => {
        const decided = o.status === OfferStatus.ACCEPTED;
        const verdict = decided
          ? null
          : this.availability.assess(
              await this.availability.slotsOf(o.workerId),
              job,
              now,
              o.etaMinutes,
            );
        const window = windowFor({
          scheduledFor: job.scheduledFor,
          durationMin: job.durationMin,
          etaMinutes: o.etaMinutes,
          now,
        });
        return {
          offerId: o.id,
          visitFee: o.visitFee,
          etaMinutes: o.etaMinutes,
          message: o.message,
          status: o.status,
          createdAt: o.createdAt.toISOString(),
          isFastest: o.etaMinutes === earliest,
          available: verdict?.free ?? true,
          startsAt: (job.bookedStartAt ?? window.startAt).toISOString(),
          nextFreeAt: verdict?.nextFreeAt?.toISOString() ?? null,
          worker: await this.cards.toCard(o.worker, spot, job.categoryId),
        };
      }),
    );
    const byFee = (a: OfferForCustomer, b: OfferForCustomer) =>
      a.visitFee - b.visitFee || a.etaMinutes - b.etaMinutes;
    const byEta = (a: OfferForCustomer, b: OfferForCustomer) =>
      a.etaMinutes - b.etaMinutes || a.visitFee - b.visitFee;
    return items.sort(
      (a, b) =>
        (sort === 'eta' ? byEta(a, b) : byFee(a, b)) ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.offerId.localeCompare(b.offerId),
    );
  }

  /**
   * "Accept Offer": assigns the worker. One transaction decides everything; the conditional update on the
   * job is the lock, so two simultaneous accepts (or accept vs. cancel/expiry) have exactly one winner.
   */
  async accept(
    customerId: string,
    jobId: string,
    offerId: string,
  ): Promise<AcceptedJob> {
    const arrivalCode = generateArrivalCode();

    const { acceptedWorkerId, rejected } = await this.prisma
      .$transaction(async (tx) => {
        const job = await tx.job.findFirst({
          where: { id: jobId, customerId },
          include: { area: { select: { lat: true, lng: true } } },
        });
        if (!job) throw notFound('Job');
        if (job.targetWorkerId !== null) {
          throw new AppException(
            'DIRECT_JOB',
            409,
            'This request was addressed to one worker, who must accept it',
          );
        }
        const offer = await tx.offer.findFirst({
          where: { id: offerId, jobId },
        });
        if (!offer) throw notFound('Quote');
        if (job.status !== JobStatus.OPEN) throw jobNotOpen();
        transition('ACCEPT_OFFER', job.status);
        if (offer.status !== OfferStatus.PENDING) throw offerNotPending();

        const now = new Date();
        // Booking confirmation (BR-16/BR-18): under a per-worker lock, make sure the worker is still
        // free for this time. If not, nothing below happens and the customer gets 409 WORKER_UNAVAILABLE.
        const window = await this.availability.reserve(
          tx,
          offer.workerId,
          job,
          offer.etaMinutes,
          'customer',
          now,
        );
        const claimed = await tx.job.updateMany({
          where: {
            id: jobId,
            customerId,
            status: JobStatus.OPEN,
            OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
          },
          data: {
            status: JobStatus.ASSIGNED,
            workerId: offer.workerId,
            acceptedOfferId: offer.id,
            assignedAt: now,
            arrivalCode,
            bookedStartAt: window.startAt,
            bookedEndAt: window.endAt,
            bookingConfirmedAt: now,
          },
        });
        if (claimed.count !== 1) throw jobNotOpen();

        const accepted = await tx.offer.updateMany({
          where: { id: offerId, status: OfferStatus.PENDING },
          data: { status: OfferStatus.ACCEPTED, acceptedAt: now },
        });
        if (accepted.count !== 1) throw offerNotPending(); // withdrawn a moment ago; the whole accept rolls back

        const others = await tx.offer.findMany({
          where: { jobId, id: { not: offerId }, status: OfferStatus.PENDING },
          select: { id: true, workerId: true },
        });
        await tx.offer.updateMany({
          where: { id: { in: others.map((o) => o.id) } },
          data: { status: OfferStatus.REJECTED },
        });
        await tx.billItem.create({
          data: {
            jobId,
            kind: BillItemKind.VISIT_FEE,
            description: 'Visiting & Inspection Fee',
            amount: offer.visitFee,
          },
        });
        return { acceptedWorkerId: offer.workerId, rejected: others };
      })
      .catch((error: unknown) => {
        throw this.availability.asConflict(error, 'customer');
      });

    // After commit: tell the people involved.
    const assigned = await this.prisma.job.findUniqueOrThrow({
      where: { id: jobId },
      include: jobInclude,
    });
    this.publisher.toUser(acceptedWorkerId, RealtimeEvent.OFFER_ACCEPTED, {
      jobId,
      offerId,
    });
    for (const other of rejected) {
      this.publisher.toUser(other.workerId, RealtimeEvent.OFFER_REJECTED, {
        jobId,
        offerId: other.id,
      });
    }
    this.events.statusChanged(assigned);
    this.events.bookingConfirmed(assigned);
    await this.events.leadClosed(assigned, 'ASSIGNED', [
      acceptedWorkerId,
      ...rejected.map((o) => o.workerId),
    ]);

    const profile = await this.prisma.workerProfile.findUniqueOrThrow({
      where: { userId: acceptedWorkerId },
      include: cardInclude,
    });
    return {
      status: assigned.status,
      arrivalCode,
      booking: {
        startAt: assigned.bookedStartAt!.toISOString(),
        endAt: assigned.bookedEndAt!.toISOString(),
        confirmedAt: assigned.bookingConfirmedAt!.toISOString(),
      },
      worker: await this.cards.toCard(
        profile,
        spotOfJob(assigned),
        assigned.categoryId,
      ),
    };
  }

  /**
   * "Accept lead": the worker says this opportunity is theirs to quote on. Separate from quoting
   * (BR-18) and checked against their schedule, so they cannot claim a time they are already booked
   * for. Idempotent. A direct request is answered through /direct/accept instead.
   */
  async acceptLead(workerId: string, jobId: string): Promise<LeadAnswer> {
    const job = await this.visibleLead(workerId, jobId);
    if (job.targetWorkerId !== null) throw directJob();
    if (
      job.status !== JobStatus.OPEN ||
      (job.expiresAt && job.expiresAt.getTime() <= Date.now())
    )
      throw jobNotOpen();

    const earlier = await this.prisma.offer.findUnique({
      where: { jobId_workerId: { jobId, workerId } },
    });
    if (isBackedOut(earlier)) throw backedOut();

    const slots = await this.availability.slotsOf(workerId);
    const availability = this.availability.assess(slots, job, new Date());
    if (!availability.free) throw scheduleConflict(availability);

    await this.deliveries.respond(jobId, workerId, LeadResponse.ACCEPTED);
    return {
      jobId,
      state: 'ACCEPTED',
      availability: toLeadAvailability(availability),
    };
  }

  /**
   * "Decline lead": hides it from the worker's radar and stops further pushes about it. A worker
   * with a live quote on it must withdraw that first.
   */
  async declineLead(workerId: string, jobId: string): Promise<LeadAnswer> {
    const job = await this.visibleLead(workerId, jobId);
    if (job.targetWorkerId !== null) throw directJob();

    const live = await this.prisma.offer.findFirst({
      where: { jobId, workerId, status: OfferStatus.PENDING },
      select: { id: true },
    });
    if (live)
      throw new AppException(
        'OFFER_EXISTS',
        409,
        'Withdraw your quote before declining this request',
      );

    await this.deliveries.respond(jobId, workerId, LeadResponse.DECLINED);
    return { jobId, state: 'DECLINED' };
  }

  // --- Internals ---

  /**
   * Loads a job the worker is entitled to quote on. Not theirs to see (other trade, outside their
   * radius, someone else's direct request, unknown id) is always the same 404.
   */
  private async visibleLead(workerId: string, jobId: string) {
    const job = await this.prisma.job.findUnique({
      where: { id: jobId },
      include: { area: { select: { cityId: true, lat: true, lng: true } } },
    });
    if (!job) throw notFound('Lead');
    if (job.customerId === workerId)
      throw new AppException(
        'OWN_JOB',
        403,
        'You cannot quote on your own request',
      );
    if (job.targetWorkerId !== null && job.targetWorkerId !== workerId)
      throw notFound('Lead');

    const worker = await this.prisma.workerProfile.findUniqueOrThrow({
      where: { userId: workerId },
      select: { ...workerGeoSelect, trades: { select: { categoryId: true } } },
    });
    if (!worker.trades.some((t) => t.categoryId === job.categoryId))
      throw notFound('Lead');
    if (
      job.targetWorkerId === null &&
      !coverageOf(worker, spotOfJob(job)).covers
    )
      throw notFound('Lead');
    return job;
  }

  private async notifyCustomer(
    customerId: string,
    offer: {
      id: string;
      jobId: string;
      visitFee: number;
      etaMinutes: number;
      message: string | null;
      status: OfferStatus;
    },
    workerId: string,
    event: typeof RealtimeEvent.OFFER_NEW | typeof RealtimeEvent.OFFER_UPDATED,
  ): Promise<void> {
    const worker = await this.prisma.workerProfile.findUniqueOrThrow({
      where: { userId: workerId },
      select: { fullName: true, ratingSum: true, reviewCount: true },
    });
    const payload: OfferPayload = {
      jobId: offer.jobId,
      offerId: offer.id,
      visitFee: offer.visitFee,
      etaMinutes: offer.etaMinutes,
      message: offer.message,
      status: offer.status,
      worker: {
        id: workerId,
        name: worker.fullName,
        rating: ratingAverage(worker.ratingSum, worker.reviewCount),
        reviewsCount: worker.reviewCount,
      },
    };
    this.publisher.toUser(customerId, event, payload);
  }
}
