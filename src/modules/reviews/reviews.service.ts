import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/exceptions/app.exception.js';
import { violatesConstraint } from '../../common/utils/db-errors.js';
import { JobStatus, type ReviewTag } from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ratingAverage } from '../workers/worker-card.service.js';
import type { CreateReviewDto } from './dto/review.dto.js';

export interface ReviewView {
  id: string;
  jobId: string;
  rating: number;
  tags: ReviewTag[];
  /** Recorded intent only: the tip is paid to the worker directly, the platform never moves it (Q-8). */
  tipAmount: number;
  createdAt: string;
}

export interface CreatedReview extends ReviewView {
  /** The worker's new totals, so the app can refresh the card without another call. */
  worker: { id: string; rating: number | null; reviewsCount: number };
}

/** What the customer sees on a worker's profile: totals, how the stars split, and the latest ratings. */
export interface WorkerReviewSummary {
  rating: number | null;
  reviewsCount: number;
  distribution: Record<'1' | '2' | '3' | '4' | '5', number>;
  /** The ten newest. Deliberately without the reviewer's name: a rating does not need to identify a customer. */
  latest: { rating: number; tags: ReviewTag[]; createdAt: string }[];
}

const LATEST = 10;
const alreadyReviewed = () =>
  new AppException(
    'ALREADY_REVIEWED',
    409,
    'You have already reviewed this job',
  );
const unknownJob = () => new AppException('NOT_FOUND', 404, 'Job not found');

@Injectable()
export class ReviewsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The job's customer reviews it once, after the payment was recorded (BR-10).
   *
   * The review row and the worker's running totals change in ONE transaction, and the totals are updated
   * with `SET x = x + n` (never read-then-write), so many customers rating the same worker at once cannot
   * lose a count. The unique index on `reviews.job_id` is what makes "once" true under a double tap: the
   * loser's transaction rolls back completely, totals included.
   */
  async create(
    customerId: string,
    jobId: string,
    dto: CreateReviewDto,
  ): Promise<CreatedReview> {
    const job = await this.prisma.job.findFirst({
      where: { id: jobId, customerId },
      select: {
        status: true,
        workerId: true,
        review: { select: { id: true } },
      },
    });
    if (!job) throw unknownJob(); // not yours and unknown look the same
    if (job.status !== JobStatus.COMPLETED || !job.workerId) {
      throw new AppException(
        'REVIEW_NOT_ALLOWED',
        409,
        'You can review a job once it is completed and paid',
      );
    }
    if (job.review) throw alreadyReviewed();

    const workerId = job.workerId;
    try {
      return await this.prisma.$transaction(async (tx) => {
        const review = await tx.review.create({
          data: {
            jobId,
            customerId,
            workerId,
            rating: dto.rating,
            tags: dto.tags ?? [],
            tipAmount: dto.tipAmount ?? 0,
          },
        });
        const worker = await tx.workerProfile.update({
          where: { userId: workerId },
          data: {
            ratingSum: { increment: dto.rating },
            reviewCount: { increment: 1 },
          },
          select: { ratingSum: true, reviewCount: true },
        });
        return {
          ...toView(review),
          worker: {
            id: workerId,
            rating: ratingAverage(worker.ratingSum, worker.reviewCount),
            reviewsCount: worker.reviewCount,
          },
        };
      });
    } catch (error) {
      if (violatesConstraint(error, 'reviews_job_id_key', '23505'))
        throw alreadyReviewed();
      throw error;
    }
  }

  /** The review of one job, or null. The caller has already decided the viewer may see the job. */
  async forJob(jobId: string): Promise<ReviewView | null> {
    const review = await this.prisma.review.findUnique({ where: { jobId } });
    return review ? toView(review) : null;
  }

  /** Totals, star distribution and the latest ten for the worker's profile screen. */
  async summaryFor(workerId: string): Promise<WorkerReviewSummary> {
    const [profile, grouped, latest] = await Promise.all([
      this.prisma.workerProfile.findUniqueOrThrow({
        where: { userId: workerId },
        select: { ratingSum: true, reviewCount: true },
      }),
      this.prisma.review.groupBy({
        by: ['rating'],
        where: { workerId },
        _count: { _all: true },
      }),
      this.prisma.review.findMany({
        where: { workerId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: LATEST,
        select: { rating: true, tags: true, createdAt: true },
      }),
    ]);
    const distribution = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 };
    for (const row of grouped)
      distribution[String(row.rating) as keyof typeof distribution] =
        row._count._all;
    return {
      rating: ratingAverage(profile.ratingSum, profile.reviewCount),
      reviewsCount: profile.reviewCount,
      distribution,
      latest: latest.map((r) => ({
        rating: r.rating,
        tags: r.tags,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  }
}

function toView(review: {
  id: string;
  jobId: string;
  rating: number;
  tags: ReviewTag[];
  tipAmount: number;
  createdAt: Date;
}): ReviewView {
  return {
    id: review.id,
    jobId: review.jobId,
    rating: review.rating,
    tags: review.tags,
    tipAmount: review.tipAmount,
    createdAt: review.createdAt.toISOString(),
  };
}
