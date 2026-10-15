import { Injectable } from '@nestjs/common';
import { referenceOf } from '../../common/utils/reference.js';
import type { Prisma } from '../../generated/prisma/client.js';
import {
  JobMediaKind,
  JobStatus,
  type CancelledBy,
  type JobTiming,
} from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { spotOfJob } from '../matching/matching.service.js';
import {
  MAX_ARRIVAL_ATTEMPTS,
  MAX_ARRIVAL_CODE_RESETS,
} from './arrival-code.js';
import { MediaPurpose } from '../media/media-rules.js';
import { VISIBLE_TO_CUSTOMER } from '../offers/visible-offers.js';
import { MediaService } from '../media/media.service.js';
import { ReviewsService, type ReviewView } from '../reviews/reviews.service.js';
import {
  WorkerCardService,
  cardInclude,
  type WorkerCard,
} from '../workers/worker-card.service.js';
import type { LeadPayload } from '../realtime/events.js';
import { placeName } from '../../common/utils/place.js';

/**
 * Everything the job screens need EXCEPT the number of quotes. For one job the quote count is cheap
 * (`jobInclude` below); for a list, fetch the page without it and count only the page's jobs with
 * `visibleOfferCounts` (see offers/visible-offers.ts for why).
 */
export const jobBaseInclude = {
  area: { include: { city: true } },
  category: {
    select: {
      id: true,
      titleEn: true,
      titleHi: true,
      titlePa: true,
      baseVisitFee: true,
    },
  },
  customer: {
    select: {
      fullName: true,
      allowDirectCalls: true,
      user: { select: { phone: true } },
    },
  },
  media: { orderBy: { createdAt: 'asc' } },
} satisfies Prisma.JobInclude;

/** Everything the job screens need, loaded in one query, including how many quotes the customer can see. */
export const jobInclude = {
  ...jobBaseInclude,
  _count: {
    select: {
      offers: { where: VISIBLE_TO_CUSTOMER },
    },
  },
} satisfies Prisma.JobInclude;

export type JobRow = Prisma.JobGetPayload<{ include: typeof jobInclude }>;

/** A job loaded without the quote count (see `jobBaseInclude`). Every `JobRow` is also one of these. */
export type JobBaseRow = Prisma.JobGetPayload<{
  include: typeof jobBaseInclude;
}>;

export interface JobView {
  id: string;
  jobNumber: number;
  /** KC-10042 style number shown in the app. */
  reference: string;
  status: JobStatus;
  title: string;
  description: string | null;
  timing: JobTiming;
  /** The appointment time the customer asked for; null = as soon as possible. */
  scheduledFor: string | null;
  durationMin: number;
  /** Set once the booking is confirmed: the window the worker is reserved for. */
  booking: { startAt: string; endAt: string; confirmedAt: string } | null;
  category: { id: string; title: { en: string; hi: string; pa: string } };
  area: { id: number; name: string };
  /** The locality the customer typed when their pocket is not in the sector list; null otherwise. */
  locality: string | null;
  city: { id: number; name: string };
  isDirect: boolean;
  expiresAt: string | null;
  createdAt: string;
  assignedAt: string | null;
  arrivedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  cancelledBy: CancelledBy | null;
  cancelReason: string | null;
  photoUrls: string[];
  voiceNote: { url: string; durationSec: number | null } | null;
  /** Before / after photos the worker took. Only the customer and the assigned worker ever see them. */
  workPhotos?: { before: string[]; after: string[] };
  offersCount: number;
  viewer: 'customer' | 'worker';
  /** Customer, or the worker assigned to the job. Nobody else ever receives the address. */
  addressLine?: string;
  lat?: number | null;
  lng?: number | null;
  /** Worker views: who asked. The phone appears only if the customer allows direct calls. */
  customer?: { name: string; phone: string | null };
  /** Customer views: the assigned worker, with contact details. */
  worker?: WorkerCard;
  /** Customer only, while the worker is on the way: the code they must be told on arrival. */
  arrivalCode?: string;
  /** While ASSIGNED: true once five wrong codes locked it. Customer: offer "issue a new code". Worker: "ask the customer for a new code". */
  arrivalLocked?: boolean;
  /** Customer only, while ASSIGNED: how many new codes can still be issued. */
  arrivalResetsLeft?: number;
  /** COMPLETED jobs, customer and assigned worker only: the rating given, or null while there is none. */
  review?: ReviewView | null;
  /** Customer only, COMPLETED: true while the job has not been rated, so the app offers the review screen. */
  canReview?: boolean;
}

/** Statuses from which the two parties may call each other. */
const IN_SERVICE: readonly JobStatus[] = [
  JobStatus.ASSIGNED,
  JobStatus.ARRIVED,
  JobStatus.IN_PROGRESS,
  JobStatus.WORK_COMPLETED,
];

export { referenceOf };

/** Builds the privacy-correct view of a job for the person asking. */
@Injectable()
export class JobViewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaService,
    private readonly cards: WorkerCardService,
    private readonly reviews: ReviewsService,
  ) {}

  forCustomer(job: JobRow): Promise<JobView> {
    return this.build(job, 'customer', job.customerId);
  }

  forWorker(job: JobRow, workerId: string): Promise<JobView> {
    return this.build(job, 'worker', workerId);
  }

  private async build(
    job: JobRow,
    viewer: 'customer' | 'worker',
    viewerId: string,
  ): Promise<JobView> {
    const isAssignedWorker = viewer === 'worker' && job.workerId === viewerId;
    const photos = job.media.filter(
      (m) => m.kind === JobMediaKind.PROBLEM_PHOTO,
    );
    const voice = job.media.find((m) => m.kind === JobMediaKind.VOICE_NOTE);

    const view: JobView = {
      id: job.id,
      jobNumber: job.jobNumber,
      reference: referenceOf(job.jobNumber),
      status: job.status,
      title: job.title,
      description: job.description,
      timing: job.timing,
      scheduledFor: job.scheduledFor?.toISOString() ?? null,
      durationMin: job.durationMin,
      booking:
        job.bookedStartAt && job.bookedEndAt && job.bookingConfirmedAt
          ? {
              startAt: job.bookedStartAt.toISOString(),
              endAt: job.bookedEndAt.toISOString(),
              confirmedAt: job.bookingConfirmedAt.toISOString(),
            }
          : null,
      category: {
        id: job.category.id,
        title: {
          en: job.category.titleEn,
          hi: job.category.titleHi,
          pa: job.category.titlePa,
        },
      },
      area: { id: job.area.id, name: job.area.name },
      locality: job.localityName,
      city: { id: job.area.city.id, name: job.area.city.name },
      isDirect: job.targetWorkerId !== null,
      expiresAt: job.expiresAt?.toISOString() ?? null,
      createdAt: job.createdAt.toISOString(),
      assignedAt: job.assignedAt?.toISOString() ?? null,
      arrivedAt: job.arrivedAt?.toISOString() ?? null,
      completedAt: job.completedAt?.toISOString() ?? null,
      cancelledAt: job.cancelledAt?.toISOString() ?? null,
      cancelledBy: job.cancelledBy,
      cancelReason: job.cancelReason,
      photoUrls: (
        await Promise.all(
          photos.map((p) =>
            this.media.readUrl(MediaPurpose.JOB_PHOTO, p.storageKey),
          ),
        )
      ).filter((u): u is string => u !== null),
      voiceNote: voice
        ? {
            url: (await this.media.readUrl(
              MediaPurpose.JOB_VOICE,
              voice.storageKey,
            ))!,
            durationSec: voice.durationSec,
          }
        : null,
      offersCount: job._count.offers,
      viewer,
    };

    const maySeeWork = viewer === 'customer' || isAssignedWorker;
    if (job.status === JobStatus.COMPLETED && maySeeWork) {
      view.review = await this.reviews.forJob(job.id);
      if (viewer === 'customer') view.canReview = view.review === null;
    }
    if (maySeeWork) view.workPhotos = await this.workPhotos(job);

    if (viewer === 'customer') {
      view.addressLine = job.addressLine;
      view.lat = job.lat;
      view.lng = job.lng;
      if (job.workerId) view.worker = await this.assignedWorkerCard(job);
      if (
        job.arrivalCode &&
        (job.status === JobStatus.ASSIGNED || job.status === JobStatus.ARRIVED)
      ) {
        view.arrivalCode = job.arrivalCode;
      }
      if (job.status === JobStatus.ASSIGNED) {
        view.arrivalLocked = job.arrivalAttempts >= MAX_ARRIVAL_ATTEMPTS;
        view.arrivalResetsLeft = Math.max(
          0,
          MAX_ARRIVAL_CODE_RESETS - job.arrivalCodeResets,
        );
      }
    } else {
      view.customer = {
        name: job.customer.fullName,
        phone:
          isAssignedWorker &&
          job.customer.allowDirectCalls &&
          IN_SERVICE.includes(job.status)
            ? job.customer.user.phone
            : null,
      };
      if (isAssignedWorker && job.status === JobStatus.ASSIGNED)
        view.arrivalLocked = job.arrivalAttempts >= MAX_ARRIVAL_ATTEMPTS;
      if (isAssignedWorker && job.status !== JobStatus.CANCELLED) {
        view.addressLine = job.addressLine;
        view.lat = job.lat;
        view.lng = job.lng;
      }
    }
    return view;
  }

  private async workPhotos(
    job: JobRow,
  ): Promise<{ before: string[]; after: string[] }> {
    const urls = async (kind: JobMediaKind) =>
      (
        await Promise.all(
          job.media
            .filter((m) => m.kind === kind)
            .map((m) =>
              this.media.readUrl(MediaPurpose.WORK_PROOF, m.storageKey),
            ),
        )
      ).filter((u): u is string => u !== null);
    return {
      before: await urls(JobMediaKind.BEFORE_PHOTO),
      after: await urls(JobMediaKind.AFTER_PHOTO),
    };
  }

  private async assignedWorkerCard(
    job: JobRow,
  ): Promise<WorkerCard | undefined> {
    const profile = await this.prisma.workerProfile.findUnique({
      where: { userId: job.workerId! },
      include: cardInclude,
    });
    if (!profile) return undefined;
    return this.cards.toCard(profile, spotOfJob(job), job.categoryId);
  }
}

/** The privacy-safe summary pushed to workers: no address, no phone, no exact location. */
export function leadPayloadOf(
  job: JobBaseRow,
  distanceKm: number | null,
  isDirect: boolean,
  offersCount: number,
): LeadPayload {
  return {
    id: job.id,
    title: job.title,
    categoryId: job.categoryId,
    areaName: placeName(job.localityName, job.area.name),
    distanceKm,
    urgency: job.timing,
    postedAt: job.createdAt.toISOString(),
    hasVoiceNote: job.media.some((m) => m.kind === JobMediaKind.VOICE_NOTE),
    offersCount,
    isDirect,
    ...(isDirect && job.expiresAt
      ? { expiresAt: job.expiresAt.toISOString() }
      : {}),
    ...(job.scheduledFor
      ? { scheduledFor: job.scheduledFor.toISOString() }
      : {}),
  };
}
