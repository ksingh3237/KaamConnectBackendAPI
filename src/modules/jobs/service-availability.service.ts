import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppException } from '../../common/exceptions/app.exception.js';
import { pointOf } from '../../common/utils/geo.js';
import type { EnvVars } from '../../config/env.validation.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { CatalogService } from '../catalog/catalog.service.js';
import { MatchingService } from '../matching/matching.service.js';
import { AvailabilityService } from '../scheduling/availability.service.js';
import { resolveScheduledFor } from '../scheduling/schedule-time.js';
import type { ServiceAvailabilityQueryDto } from './dto/job.dto.js';

/**
 *  - NONE: no verified worker offers this service at this place.
 *  - ALL_BUSY: there are some, but every one is switched off ("not taking jobs") or already booked at that time.
 *  - AVAILABLE: at least one could take it.
 */
export type ServiceAvailabilityState = 'NONE' | 'ALL_BUSY' | 'AVAILABLE';

export interface ServiceAvailability {
  state: ServiceAvailabilityState;
  /** The appointment time the answer is for; null = as soon as possible. */
  scheduledFor: string | null;
}

/**
 * "Is anyone there for this?", asked while the customer fills in Post Job, so they are warned before posting into
 * silence. Advisory only: posting is never refused because of it. Uses the same rules as the real thing: matching's
 * coverage (radius, live position or base area by time, BR-19) and the booking-window check a quote must pass.
 */
@Injectable()
export class ServiceAvailabilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<EnvVars, true>,
    private readonly catalog: CatalogService,
    private readonly matching: MatchingService,
    private readonly availability: AvailabilityService,
  ) {}

  async check(
    userId: string,
    query: ServiceAvailabilityQueryDto,
    now: Date = new Date(),
  ): Promise<ServiceAvailability> {
    await this.catalog.assertCategoriesActive([query.categoryId], 'categoryId');
    await this.catalog.assertAreaExists(query.areaId, 'areaId');
    const [category, area] = await Promise.all([
      this.prisma.serviceCategory.findUniqueOrThrow({
        where: { id: query.categoryId },
        select: { defaultDurationMin: true },
      }),
      this.prisma.area.findUniqueOrThrow({
        where: { id: query.areaId },
        select: { cityId: true, lat: true, lng: true },
      }),
    ]);

    const schedule = resolveScheduledFor(
      query.timing,
      query.scheduledFor ? new Date(query.scheduledFor) : undefined,
      now,
      {
        minLeadMin: this.config.get('SCHEDULE_MIN_LEAD_MIN', { infer: true }),
        maxDays: this.config.get('SCHEDULE_MAX_DAYS', { infer: true }),
      },
    );
    if (!schedule.ok)
      throw new AppException(
        'VALIDATION_FAILED',
        422,
        'Request validation failed',
        [{ field: 'scheduledFor', issue: schedule.issue }],
      );
    const scheduledFor = schedule.scheduledFor;
    const answer = (state: ServiceAvailabilityState): ServiceAvailability => ({
      state,
      scheduledFor: scheduledFor?.toISOString() ?? null,
    });

    const lat = query.lat ?? null;
    const lng = query.lng ?? null;
    const serving = await this.matching.findServingWorkers({
      categoryId: query.categoryId,
      customerId: userId,
      spot: {
        point: pointOf(lat, lng) ?? pointOf(area.lat, area.lng),
        cityId: area.cityId,
        startsAt: scheduledFor,
      },
    });
    if (serving.length === 0) return answer('NONE');

    // Switched off counts as unavailable, whatever their calendar says.
    const online = serving.filter((w) => w.isAvailable).map((w) => w.workerId);
    const slots = await this.availability.slotsOfMany(online);
    const job = {
      scheduledFor,
      durationMin:
        category.defaultDurationMin ??
        this.config.get('BOOKING_DEFAULT_DURATION_MIN', { infer: true }),
      lat,
      lng,
      area: { lat: area.lat, lng: area.lng },
    };
    const someoneFree = online.some(
      (id) => this.availability.assess(slots.get(id) ?? [], job, now).free,
    );
    return answer(someoneFree ? 'AVAILABLE' : 'ALL_BUSY');
  }
}
