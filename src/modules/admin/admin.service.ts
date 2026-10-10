import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/exceptions/app.exception.js';
import { decodeCursor, toPage, type Page } from '../../common/utils/cursor.js';
import {
  DocumentType,
  VerificationStatus,
  type Language,
} from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { MediaPurpose } from '../media/media-rules.js';
import { MediaService } from '../media/media.service.js';

export interface AdminWorkerItem {
  userId: string;
  phone: string;
  fullName: string;
  photoUrl: string | null;
  verificationStatus: VerificationStatus;
  rejectionReason: string | null;
  badge: string | null;
  trades: { categoryId: string; isPrimary: boolean }[];
  baseArea: { id: number; name: string; city: string };
  experienceYears: number;
  languages: Language[];
  skills: string[];
  vehicle: string | null;
  upiId: string | null;
  createdAt: Date;
  /** Short-lived (5 min) signed links, or null if that side was not uploaded. Admin eyes only. */
  documents: Record<DocumentType, string | null>;
}

const DEFAULT_LIMIT = 20;

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaService,
  ) {}

  /** The assumed length of a visit for one service; the job-creation rule reads it (decision D-14). */
  async setServiceDuration(
    categoryId: string,
    defaultDurationMin: number | null,
  ): Promise<{ id: string; defaultDurationMin: number | null }> {
    const updated = await this.prisma.serviceCategory.updateMany({
      where: { id: categoryId },
      data: { defaultDurationMin },
    });
    if (updated.count === 0)
      throw new AppException('NOT_FOUND', 404, 'Service not found');
    return { id: categoryId, defaultDurationMin };
  }

  /** Review queue, oldest first so nobody waits forever. */
  async listWorkers(input: {
    status?: VerificationStatus;
    limit?: number;
    cursor?: string;
  }): Promise<Page<AdminWorkerItem>> {
    const limit = input.limit ?? DEFAULT_LIMIT;
    const after = input.cursor ? decodeCursor(input.cursor) : undefined;

    const rows = await this.prisma.workerProfile.findMany({
      where: { verificationStatus: input.status ?? VerificationStatus.PENDING },
      orderBy: [{ createdAt: 'asc' }, { userId: 'asc' }],
      take: limit + 1,
      ...(after ? { cursor: { userId: after }, skip: 1 } : {}),
      include: {
        user: { select: { phone: true } },
        trades: { orderBy: [{ isPrimary: 'desc' }, { categoryId: 'asc' }] },
        documents: true,
        baseArea: { include: { city: true } },
      },
    });

    const page = toPage(rows, limit, (r) => r.userId);
    const items = await Promise.all(
      page.items.map(async (w): Promise<AdminWorkerItem> => {
        const link = async (type: DocumentType) => {
          const doc = w.documents.find((d) => d.type === type);
          return doc ? this.media.adminAadhaarUrl(doc.storageKey) : null;
        };
        return {
          userId: w.userId,
          phone: w.user.phone,
          fullName: w.fullName,
          photoUrl: await this.media.readUrl(
            MediaPurpose.PROFILE_PHOTO,
            w.photoKey,
          ),
          verificationStatus: w.verificationStatus,
          rejectionReason: w.rejectionReason,
          badge: w.badge,
          trades: w.trades.map((t) => ({
            categoryId: t.categoryId,
            isPrimary: t.isPrimary,
          })),
          baseArea: {
            id: w.baseArea.id,
            name: w.baseArea.name,
            city: w.baseArea.city.name,
          },
          experienceYears: w.experienceYears,
          languages: w.languages,
          skills: w.skills,
          vehicle: w.vehicle,
          upiId: w.upiId,
          createdAt: w.createdAt,
          documents: {
            [DocumentType.AADHAAR_FRONT]: await link(
              DocumentType.AADHAAR_FRONT,
            ),
            [DocumentType.AADHAAR_BACK]: await link(DocumentType.AADHAAR_BACK),
          },
        };
      }),
    );
    return { items, nextCursor: page.nextCursor };
  }
}
