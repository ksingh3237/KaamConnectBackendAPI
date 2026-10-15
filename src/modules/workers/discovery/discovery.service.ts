import { Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../../common/exceptions/app.exception.js';
import { pageAfterId } from '../../../common/utils/keyset.js';
import type { Page } from '../../../common/utils/cursor.js';
import { pointOf } from '../../../common/utils/geo.js';
import {
  VerificationStatus,
  type Language,
} from '../../../generated/prisma/enums.js';
import { PrismaService } from '../../../prisma/prisma.service.js';
import { CatalogService } from '../../catalog/catalog.service.js';
import {
  coverageOf,
  workerGeoSelect,
  type Spot,
} from '../../matching/matching.service.js';
import {
  WorkerCardService,
  cardInclude,
  ratingAverage,
  type WorkerCard,
} from '../worker-card.service.js';
import {
  ReviewsService,
  type WorkerReviewSummary,
} from '../../reviews/reviews.service.js';
import type { DiscoverWorkersQueryDto } from './discovery.dto.js';

const DEFAULT_LIMIT = 20;
/**
 * Safety valve on how many workers one request will weigh. It sits far above any launch-scale
 * trade (the benchmark uses 5,000 workers in total); if it is ever reached we log it, because the
 * result would then be silently incomplete and it is time to move this filter into SQL.
 */
const CANDIDATE_CAP = 20_000;

export interface WorkerDetail extends WorkerCard {
  languages: Language[];
  radiusKm: number;
  trades: { categoryId: string; title: string; isPrimary: boolean }[];
  /** Totals, the star split and the ten newest ratings (no reviewer identity). */
  reviews: WorkerReviewSummary;
}

/** "Verified Artisans Near You": the customer-side view of workers. */
@Injectable()
export class DiscoveryService {
  private readonly logger = new Logger(DiscoveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CatalogService,
    private readonly cards: WorkerCardService,
    private readonly reviews: ReviewsService,
  ) {}

  async list(
    customerId: string,
    query: DiscoverWorkersQueryDto,
  ): Promise<Page<WorkerCard>> {
    if (query.categoryId)
      await this.catalog.assertCategoriesActive(
        [query.categoryId],
        'categoryId',
      );
    const viewer = await this.viewerSpot(customerId, query.areaId);

    // Step 1: a LIGHT row per verified worker (just what the coverage and sort rules need). Nobody
    // is dropped before the coverage filter runs, so the answer does not depend on row order.
    const candidates = await this.prisma.workerProfile.findMany({
      where: {
        verificationStatus: VerificationStatus.VERIFIED,
        isAvailable: true, // switched off = not listed for customers
        userId: { not: customerId },
        ...(query.categoryId
          ? { trades: { some: { categoryId: query.categoryId } } }
          : {}),
      },
      select: { ...workerGeoSelect, ratingSum: true, reviewCount: true },
      take: CANDIDATE_CAP,
    });
    if (candidates.length === CANDIDATE_CAP) {
      this.logger.warn(
        `Discovery hit its ${CANDIDATE_CAP}-worker safety cap; results are incomplete. Move the filter into SQL.`,
      );
    }

    // Step 2: keep workers who serve the customer's spot (everyone if the spot is unknown), then sort.
    const now = Date.now();
    const scored = candidates
      .map((worker) => ({
        userId: worker.userId,
        reviewCount: worker.reviewCount,
        coverage: viewer
          ? coverageOf(worker, viewer, now)
          : { covers: true, distanceKm: null },
        rating: ratingAverage(worker.ratingSum, worker.reviewCount),
      }))
      .filter((c) => c.coverage.covers);

    type Scored = (typeof scored)[number];
    const byNearest = (a: Scored, b: Scored) =>
      (a.coverage.distanceKm ?? Infinity) - (b.coverage.distanceKm ?? Infinity);
    const byRating = (a: Scored, b: Scored) =>
      (b.rating ?? -1) - (a.rating ?? -1) || b.reviewCount - a.reviewCount;
    const primary = query.sort === 'rating' ? byRating : byNearest;
    const secondary = query.sort === 'rating' ? byNearest : byRating;
    // userId is the final tie-break so the order, and therefore the cursor, is stable.
    scored.sort(
      (a, b) =>
        primary(a, b) || secondary(a, b) || a.userId.localeCompare(b.userId),
    );

    const page = pageAfterId(
      scored,
      query.limit ?? DEFAULT_LIMIT,
      query.cursor,
      (c) => c.userId,
    );

    // Step 3: only now load the heavy card data (trades, area, phone), for the page being returned.
    const profiles = await this.prisma.workerProfile.findMany({
      where: { userId: { in: page.items.map((c) => c.userId) } },
      include: cardInclude,
    });
    const byId = new Map(profiles.map((p) => [p.userId, p]));
    const items = await Promise.all(
      page.items.flatMap((c) => {
        const profile = byId.get(c.userId);
        return profile
          ? [this.cards.toCard(profile, viewer, query.categoryId)]
          : [];
      }),
    );
    return { items, nextCursor: page.nextCursor };
  }

  async get(customerId: string, workerId: string): Promise<WorkerDetail> {
    const profile = await this.prisma.workerProfile.findFirst({
      where: {
        userId: workerId,
        verificationStatus: VerificationStatus.VERIFIED,
      },
      include: cardInclude,
    });
    if (!profile) throw new AppException('NOT_FOUND', 404, 'Worker not found');

    const viewer = await this.viewerSpot(customerId, undefined);
    const card = await this.cards.toCard(profile, viewer);
    return {
      ...card,
      languages: profile.languages,
      radiusKm: profile.radiusKm,
      trades: profile.trades.map((t) => ({
        categoryId: t.categoryId,
        title: t.category.titleEn,
        isPrimary: t.isPrimary,
      })),
      reviews: await this.reviews.summaryFor(workerId),
    };
  }

  /** The area the customer asked about, else their primary address. Null if neither is known. */
  private async viewerSpot(
    customerId: string,
    areaId: number | undefined,
  ): Promise<Spot | null> {
    if (areaId !== undefined) {
      await this.catalog.assertAreaExists(areaId, 'areaId');
      const area = await this.prisma.area.findUniqueOrThrow({
        where: { id: areaId },
      });
      return { point: pointOf(area.lat, area.lng), cityId: area.cityId };
    }
    const address = await this.prisma.address.findFirst({
      where: { customerId, isPrimary: true },
      include: { area: true },
    });
    if (!address) return null;
    return {
      point:
        pointOf(address.lat, address.lng) ??
        pointOf(address.area.lat, address.area.lng),
      cityId: address.area.cityId,
    };
  }
}
