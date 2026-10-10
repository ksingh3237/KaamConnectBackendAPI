import { Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../common/exceptions/app.exception.js';
import {
  DocumentType,
  JobStatus,
  VerificationStatus,
  type Language,
} from '../../generated/prisma/enums.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { CatalogService } from '../catalog/catalog.service.js';
import { MediaPurpose } from '../media/media-rules.js';
import { MediaService } from '../media/media.service.js';
import type { UpdateWorkerDto, UpsertWorkerDto } from './dto/worker.dto.js';
import { WorkerVerificationService } from './worker-verification.service.js';

/** A worker's own view of their profile. Document keys and Aadhaar images are never included. */
export interface WorkerView {
  userId: string;
  fullName: string;
  photoUrl: string | null;
  trades: { categoryId: string; isPrimary: boolean }[];
  experienceYears: number;
  skills: string[];
  languages: Language[];
  baseArea: { id: number; name: string };
  city: { id: number; name: string };
  radiusKm: number;
  /** How far they will travel for future bookings; null = same as radiusKm. */
  scheduledRadiusKm: number | null;
  visitingFee: number | null;
  vehicle: string | null;
  upiId: string | null;
  badge: string | null;
  verificationStatus: VerificationStatus;
  rejectionReason: string | null;
  documents: Record<DocumentType, boolean>;
  /** Average rating to one decimal, or null before the first review. */
  ratingAvg: number | null;
  reviewCount: number;
}

/** Minimum gap between stored GPS fixes per worker (docs/03-api-spec.md section 6). */
export const LOCATION_MIN_INTERVAL_MS = 3000;

/** A stored GPS fix, and the one before it, handed to whoever reacts to a worker moving. */
export interface LocationChange {
  workerId: string;
  lat: number;
  lng: number;
  /** The fix this one replaced; null for a worker's first. */
  previous: { lat: number; lng: number; updatedAt: Date } | null;
}

export type LocationListener = (change: LocationChange) => Promise<void>;

const profileInclude = {
  trades: { orderBy: [{ isPrimary: 'desc' }, { categoryId: 'asc' }] },
  documents: { select: { type: true } },
  baseArea: { include: { city: true } },
} satisfies Prisma.WorkerProfileInclude;

@Injectable()
export class WorkersService {
  private readonly logger = new Logger(WorkersService.name);
  private readonly locationListeners: LocationListener[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CatalogService,
    private readonly media: MediaService,
    private readonly verification: WorkerVerificationService,
  ) {}

  async get(userId: string): Promise<WorkerView> {
    const profile = await this.prisma.workerProfile.findUnique({
      where: { userId },
      include: profileInclude,
    });
    if (!profile)
      throw new AppException(
        'PROFILE_NOT_FOUND',
        404,
        'Worker profile not found',
      );
    return this.toView(profile);
  }

  /**
   * Worker onboarding "Save". Creates the profile or replaces its fields, and re-opens a rejected
   * profile for review. The terms-accepted time is set once, on the first save.
   */
  async upsert(userId: string, dto: UpsertWorkerDto): Promise<WorkerView> {
    await this.validateReferences(userId, dto);
    assertScheduledRadius(dto.radiusKm, dto.scheduledRadiusKm);

    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.workerProfile.findUnique({
        where: { userId },
        select: { verificationStatus: true },
      });
      const fields = {
        fullName: dto.fullName,
        photoKey: dto.photoKey,
        baseAreaId: dto.baseAreaId,
        radiusKm: dto.radiusKm,
        scheduledRadiusKm: dto.scheduledRadiusKm,
        experienceYears: dto.experienceYears,
        languages: dto.languages,
        skills: dto.skills,
        visitingFee: dto.visitingFee,
        vehicle: dto.vehicle,
        upiId: dto.upiId,
      };
      await tx.workerProfile.upsert({
        where: { userId },
        create: { userId, ...fields, termsAcceptedAt: new Date() },
        update: { ...fields, ...resubmission(existing?.verificationStatus) },
      });
      await replaceTrades(tx, userId, dto.trades);
      await this.verification.autoApproveIfEligible(tx, userId);
    });
    return this.get(userId);
  }

  async patch(userId: string, dto: UpdateWorkerDto): Promise<WorkerView> {
    await this.validateReferences(userId, dto);

    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.workerProfile.findUnique({
        where: { userId },
        select: { verificationStatus: true, radiusKm: true },
      });
      if (!existing)
        throw new AppException(
          'PROFILE_NOT_FOUND',
          404,
          'Worker profile not found',
        );
      if (dto.scheduledRadiusKm != null)
        assertScheduledRadius(
          dto.radiusKm ?? existing.radiusKm,
          dto.scheduledRadiusKm,
        );

      await tx.workerProfile.update({
        where: { userId },
        data: {
          fullName: dto.fullName,
          photoKey: dto.photoKey, // undefined = unchanged, null = remove
          baseAreaId: dto.baseAreaId,
          radiusKm: dto.radiusKm,
          scheduledRadiusKm: dto.scheduledRadiusKm, // undefined = unchanged, null = clear
          experienceYears: dto.experienceYears,
          languages: dto.languages,
          skills: dto.skills,
          visitingFee: dto.visitingFee,
          vehicle: dto.vehicle,
          upiId: dto.upiId,
          ...resubmission(existing.verificationStatus),
        },
      });
      if (dto.trades) await replaceTrades(tx, userId, dto.trades);
      await this.verification.autoApproveIfEligible(tx, userId);
    });
    return this.get(userId);
  }

  /**
   * Attaches an uploaded Aadhaar image. Replacing a document sends a VERIFIED or REJECTED
   * profile back to PENDING, because the evidence it was judged on has changed.
   */
  async setDocument(
    userId: string,
    type: DocumentType,
    key: string,
  ): Promise<WorkerView> {
    await this.media.assertOwnedUpload(
      userId,
      MediaPurpose.AADHAAR,
      key,
      'key',
    );

    await this.prisma.$transaction(async (tx) => {
      await tx.workerDocument.upsert({
        where: { workerId_type: { workerId: userId, type } },
        create: { workerId: userId, type, storageKey: key },
        update: { storageKey: key },
      });
      await tx.workerProfile.updateMany({
        where: {
          userId,
          verificationStatus: { not: VerificationStatus.PENDING },
        },
        data: {
          verificationStatus: VerificationStatus.PENDING,
          verifiedAt: null,
          rejectionReason: null,
        },
      });
      await this.verification.autoApproveIfEligible(tx, userId);
    });
    return this.get(userId);
  }

  /** Latest GPS fix. Fixes arriving faster than LOCATION_MIN_INTERVAL_MS are acknowledged but dropped. */
  async updateLocation(
    userId: string,
    lat: number,
    lng: number,
  ): Promise<{ accepted: boolean }> {
    await this.assertMayShareLocation(userId);
    const current = await this.prisma.workerLocation.findUnique({
      where: { workerId: userId },
    });
    if (
      current &&
      Date.now() - current.updatedAt.getTime() < LOCATION_MIN_INTERVAL_MS
    ) {
      return { accepted: false };
    }
    await this.prisma.workerLocation.upsert({
      where: { workerId: userId },
      create: { workerId: userId, lat, lng },
      update: { lat, lng },
    });
    await this.notifyLocation({
      workerId: userId,
      lat,
      lng,
      previous: current
        ? { lat: current.lat, lng: current.lng, updatedAt: current.updatedAt }
        : null,
    });
    return { accepted: true };
  }

  /**
   * Lets another module react to a stored fix (re-running lead matching) without this one importing
   * it. A failing listener is logged and never fails the worker's location ping.
   */
  onLocationFix(listener: LocationListener): void {
    this.locationListeners.push(listener);
  }

  private async notifyLocation(change: LocationChange): Promise<void> {
    for (const listener of this.locationListeners) {
      try {
        await listener(change);
      } catch (error) {
        this.logger.error(
          `Location listener failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /** Verified workers always; anyone else only while a job is assigned to them (they are en route or on site). */
  private async assertMayShareLocation(userId: string): Promise<void> {
    const profile = await this.prisma.workerProfile.findUnique({
      where: { userId },
      select: { verificationStatus: true },
    });
    if (!profile)
      throw new AppException(
        'WORKER_PROFILE_REQUIRED',
        403,
        'Complete your worker profile first',
      );
    if (profile.verificationStatus === VerificationStatus.VERIFIED) return;
    const onAJob = await this.prisma.job.count({
      where: {
        workerId: userId,
        status: { in: [JobStatus.ASSIGNED, JobStatus.ARRIVED] },
      },
    });
    if (onAJob === 0)
      throw new AppException(
        'NOT_VERIFIED',
        403,
        'Your worker profile is not verified yet',
      );
  }

  private async validateReferences(
    userId: string,
    dto: { baseAreaId?: number; trades?: string[]; photoKey?: string | null },
  ): Promise<void> {
    if (dto.baseAreaId !== undefined)
      await this.catalog.assertAreaExists(dto.baseAreaId, 'baseAreaId');
    if (dto.trades)
      await this.catalog.assertCategoriesActive(dto.trades, 'trades');
    if (dto.photoKey)
      await this.media.assertOwnedUpload(
        userId,
        MediaPurpose.PROFILE_PHOTO,
        dto.photoKey,
        'photoKey',
      );
  }

  private async toView(profile: {
    userId: string;
    fullName: string;
    photoKey: string | null;
    experienceYears: number;
    skills: string[];
    languages: Language[];
    radiusKm: number;
    scheduledRadiusKm: number | null;
    visitingFee: number | null;
    vehicle: string | null;
    upiId: string | null;
    badge: string | null;
    verificationStatus: VerificationStatus;
    rejectionReason: string | null;
    ratingSum: number;
    reviewCount: number;
    trades: { categoryId: string; isPrimary: boolean }[];
    documents: { type: DocumentType }[];
    baseArea: { id: number; name: string; city: { id: number; name: string } };
  }): Promise<WorkerView> {
    const present = new Set(profile.documents.map((d) => d.type));
    return {
      userId: profile.userId,
      fullName: profile.fullName,
      photoUrl: await this.media.readUrl(
        MediaPurpose.PROFILE_PHOTO,
        profile.photoKey,
      ),
      trades: profile.trades.map((t) => ({
        categoryId: t.categoryId,
        isPrimary: t.isPrimary,
      })),
      experienceYears: profile.experienceYears,
      skills: profile.skills,
      languages: profile.languages,
      baseArea: { id: profile.baseArea.id, name: profile.baseArea.name },
      city: { id: profile.baseArea.city.id, name: profile.baseArea.city.name },
      radiusKm: profile.radiusKm,
      scheduledRadiusKm: profile.scheduledRadiusKm,
      visitingFee: profile.visitingFee,
      vehicle: profile.vehicle,
      upiId: profile.upiId,
      badge: profile.badge,
      verificationStatus: profile.verificationStatus,
      rejectionReason: profile.rejectionReason,
      documents: {
        [DocumentType.AADHAAR_FRONT]: present.has(DocumentType.AADHAAR_FRONT),
        [DocumentType.AADHAAR_BACK]: present.has(DocumentType.AADHAAR_BACK),
      },
      ratingAvg:
        profile.reviewCount === 0
          ? null
          : Math.round((profile.ratingSum / profile.reviewCount) * 10) / 10,
      reviewCount: profile.reviewCount,
    };
  }
}

/** The wider travel radius for future work must not be smaller than the live one (docs BR-20). */
function assertScheduledRadius(
  radiusKm: number | undefined,
  scheduledRadiusKm: number | undefined,
): void {
  if (
    radiusKm !== undefined &&
    scheduledRadiusKm !== undefined &&
    scheduledRadiusKm < radiusKm
  ) {
    throw new AppException(
      'VALIDATION_FAILED',
      422,
      'Request validation failed',
      [
        {
          field: 'scheduledRadiusKm',
          issue: 'must not be smaller than radiusKm',
        },
      ],
    );
  }
}

/** Editing a rejected profile counts as asking for another review. */
function resubmission(status: VerificationStatus | undefined) {
  return status === VerificationStatus.REJECTED
    ? { verificationStatus: VerificationStatus.PENDING, rejectionReason: null }
    : {};
}

/** The first id is the primary trade. Delete-then-insert keeps the "one primary" index happy. */
async function replaceTrades(
  tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0],
  workerId: string,
  categoryIds: string[],
): Promise<void> {
  await tx.workerTrade.deleteMany({ where: { workerId } });
  await tx.workerTrade.createMany({
    data: categoryIds.map((categoryId, index) => ({
      workerId,
      categoryId,
      isPrimary: index === 0,
    })),
  });
}
