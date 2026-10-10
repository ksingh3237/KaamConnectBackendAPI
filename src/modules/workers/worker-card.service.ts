import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { etaMinutes } from '../../common/utils/geo.js';
import type { EnvVars } from '../../config/env.validation.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { MediaPurpose } from '../media/media-rules.js';
import { MediaService } from '../media/media.service.js';
import { coverageOf, type Spot } from '../matching/matching.service.js';

/** Everything needed to draw a worker on a customer's screen (Home list, compare-offers, tracking). */
export const cardInclude = {
  user: { select: { phone: true } },
  baseArea: { include: { city: true } },
  trades: {
    include: {
      category: { select: { id: true, titleEn: true, baseVisitFee: true } },
    },
    orderBy: [{ isPrimary: 'desc' }, { categoryId: 'asc' }],
  },
  location: { select: { lat: true, lng: true, updatedAt: true } },
} satisfies Prisma.WorkerProfileInclude;

export type CardProfile = Prisma.WorkerProfileGetPayload<{
  include: typeof cardInclude;
}>;

export interface WorkerCard {
  id: string;
  name: string;
  /** English title of the trade shown (the trade the customer asked for, else the primary one). */
  trade: string;
  tradeId: string;
  areaName: string;
  cityName: string;
  distanceKm: number | null;
  /** One decimal, or null before the first review. */
  rating: number | null;
  reviewsCount: number;
  /** The worker's own fee, else the category's base visit fee. */
  visitingFee: number;
  etaMinutes: number | null;
  badge: string | null;
  experienceYears: number;
  vehicle: string | null;
  skills: string[];
  photoUrl: string | null;
  /** Direct calling is a core feature (decision Q-16): shown to logged-in customers only. */
  phone: string;
}

/** Average to one decimal, or null when nobody has reviewed yet. */
export function ratingAverage(sum: number, count: number): number | null {
  return count === 0 ? null : Math.round((sum / count) * 10) / 10;
}

@Injectable()
export class WorkerCardService {
  constructor(
    private readonly media: MediaService,
    private readonly config: ConfigService<EnvVars, true>,
  ) {}

  /**
   * `viewer` is where the customer is (for distance and ETA); `categoryId` picks which of the worker's
   * (up to two) trades to show.
   */
  async toCard(
    profile: CardProfile,
    viewer: Spot | null,
    categoryId?: string,
  ): Promise<WorkerCard> {
    const trade =
      (categoryId && profile.trades.find((t) => t.categoryId === categoryId)) ||
      profile.trades[0];
    const distanceKm = viewer ? coverageOf(profile, viewer).distanceKm : null;

    return {
      id: profile.userId,
      name: profile.fullName,
      trade: trade?.category.titleEn ?? '',
      tradeId: trade?.categoryId ?? '',
      areaName: profile.baseArea.name,
      cityName: profile.baseArea.city.name,
      distanceKm,
      rating: ratingAverage(profile.ratingSum, profile.reviewCount),
      reviewsCount: profile.reviewCount,
      visitingFee: profile.visitingFee ?? trade?.category.baseVisitFee ?? 0,
      etaMinutes:
        distanceKm === null
          ? null
          : etaMinutes(
              distanceKm,
              this.config.get('AVG_SPEED_KMH', { infer: true }),
            ),
      badge: profile.badge,
      experienceYears: profile.experienceYears,
      vehicle: profile.vehicle,
      skills: profile.skills,
      photoUrl: await this.media.readUrl(
        MediaPurpose.PROFILE_PHOTO,
        profile.photoKey,
      ),
      phone: profile.user.phone,
    };
  }
}
