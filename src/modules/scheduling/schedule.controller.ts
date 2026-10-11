import { Controller, Get, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsDate, IsInt, IsOptional, Max, Min } from 'class-validator';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '../../common/decorators/current-user.decorator.js';
import { RequireProfile } from '../../common/decorators/require-profile.decorator.js';
import { referenceOf } from '../../common/utils/reference.js';
import { JobStatus } from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { OCCUPYING_STATUSES } from './booking-window.js';

export class ScheduleQueryDto {
  /** Only bookings that end after this time (default: now). */
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  from?: Date;

  /** Only bookings that start before this time. */
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  to?: Date;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export interface BookingItem {
  jobId: string;
  reference: string;
  title: string;
  status: JobStatus;
  category: { id: string; title: string };
  areaName: string;
  cityName: string;
  /** What the customer asked for; null = as soon as possible. */
  scheduledFor: string | null;
  startAt: string;
  endAt: string;
  durationMin: number;
  /** The worker is already at the customer's (arrived or working). */
  onSite: boolean;
}

export interface WorkerSchedule {
  /** The one job the worker is on site for, if any. */
  inProgress: BookingItem | null;
  /** Confirmed bookings, earliest first. */
  upcoming: BookingItem[];
}

/** A worker's calendar: the job in progress plus every confirmed booking still to come. */
@RequireProfile('worker')
@Controller('workers/me/schedule')
export class ScheduleController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async get(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ScheduleQueryDto,
  ): Promise<WorkerSchedule> {
    const from = query.from ?? new Date();
    const rows = await this.prisma.job.findMany({
      where: {
        workerId: user.id,
        status: { in: [...OCCUPYING_STATUSES] },
        bookedStartAt: { not: null, ...(query.to ? { lt: query.to } : {}) },
        // A job in progress stays on the calendar even if it has run past its planned end.
        OR: [
          { bookedEndAt: { gt: from } },
          { status: { in: [JobStatus.ARRIVED, JobStatus.IN_PROGRESS] } },
        ],
      },
      orderBy: { bookedStartAt: 'asc' },
      take: query.limit ?? 50,
      include: {
        area: { include: { city: true } },
        category: { select: { id: true, titleEn: true } },
      },
    });

    const items = rows.flatMap((r): BookingItem[] =>
      r.bookedStartAt && r.bookedEndAt
        ? [
            {
              jobId: r.id,
              reference: referenceOf(r.jobNumber),
              title: r.title,
              status: r.status,
              category: { id: r.category.id, title: r.category.titleEn },
              areaName: r.area.name,
              cityName: r.area.city.name,
              scheduledFor: r.scheduledFor?.toISOString() ?? null,
              startAt: r.bookedStartAt.toISOString(),
              endAt: r.bookedEndAt.toISOString(),
              durationMin: r.durationMin,
              onSite:
                r.status === JobStatus.ARRIVED ||
                r.status === JobStatus.IN_PROGRESS,
            },
          ]
        : [],
    );
    return {
      inProgress: items.find((i) => i.onSite) ?? null,
      upcoming: items.filter((i) => !i.onSite),
    };
  }
}
