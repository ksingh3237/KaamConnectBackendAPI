import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppException } from '../../common/exceptions/app.exception.js';
import {
  WorkerVerificationMode,
  type EnvVars,
} from '../../config/env.validation.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { VerificationStatus } from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';

type Db = Prisma.TransactionClient;

export const WORKER_VERIFICATION_MODE = Symbol('WORKER_VERIFICATION_MODE');

/** Exposes the configured mode as an injectable value, so tests can run either mode. */
export const verificationModeProvider: Provider = {
  provide: WORKER_VERIFICATION_MODE,
  inject: [ConfigService],
  useFactory: (config: ConfigService<EnvVars, true>) =>
    config.get('WORKER_VERIFICATION_MODE', { infer: true }),
};

/** Aadhaar front and back are both required before a worker can be verified. */
export const REQUIRED_DOCUMENTS = 2;

export interface VerificationOutcome {
  userId: string;
  verificationStatus: VerificationStatus;
  badge: string | null;
  rejectionReason: string | null;
}

/**
 * Who is allowed to become VERIFIED (and therefore appear to customers).
 *  - manual (production): only an admin, after looking at the documents.
 *  - auto (development): simulated "instant verification" once both Aadhaar images exist.
 */
@Injectable()
export class WorkerVerificationService {
  private readonly logger = new Logger('WorkerVerification');

  constructor(
    private readonly prisma: PrismaService,
    @Inject(WORKER_VERIFICATION_MODE)
    private readonly mode: WorkerVerificationMode,
  ) {}

  /** Called after a worker saves their profile or uploads a document. No-op in manual mode. */
  async autoApproveIfEligible(db: Db, workerId: string): Promise<void> {
    if (this.mode !== WorkerVerificationMode.Auto) return;
    const documents = await db.workerDocument.count({ where: { workerId } });
    if (documents < REQUIRED_DOCUMENTS) return;
    await db.workerProfile.updateMany({
      where: {
        userId: workerId,
        verificationStatus: VerificationStatus.PENDING,
      },
      data: {
        verificationStatus: VerificationStatus.VERIFIED,
        verifiedAt: new Date(),
        rejectionReason: null,
      },
    });
  }

  async approve(
    adminId: string,
    workerId: string,
    badge?: string,
  ): Promise<VerificationOutcome> {
    // Existence first, so an unknown id is a 404 rather than a misleading "documents missing".
    const exists = await this.prisma.workerProfile.findUnique({
      where: { userId: workerId },
      select: { userId: true },
    });
    if (!exists) throw workerNotFound();

    const documents = await this.prisma.workerDocument.count({
      where: { workerId },
    });
    if (documents < REQUIRED_DOCUMENTS) {
      throw new AppException(
        'DOCUMENTS_MISSING',
        409,
        'Both Aadhaar images must be uploaded before verifying',
      );
    }
    const updated = await this.prisma.workerProfile.updateMany({
      where: { userId: workerId },
      data: {
        verificationStatus: VerificationStatus.VERIFIED,
        verifiedAt: new Date(),
        rejectionReason: null,
        ...(badge !== undefined ? { badge } : {}),
      },
    });
    if (updated.count === 0) throw workerNotFound();
    this.logger.log(`admin=${adminId} VERIFIED worker=${workerId}`);
    return this.outcome(workerId);
  }

  async reject(
    adminId: string,
    workerId: string,
    reason: string,
  ): Promise<VerificationOutcome> {
    const updated = await this.prisma.workerProfile.updateMany({
      where: { userId: workerId },
      data: {
        verificationStatus: VerificationStatus.REJECTED,
        verifiedAt: null,
        rejectionReason: reason,
      },
    });
    if (updated.count === 0) throw workerNotFound();
    this.logger.log(`admin=${adminId} REJECTED worker=${workerId}`);
    return this.outcome(workerId);
  }

  private async outcome(workerId: string): Promise<VerificationOutcome> {
    const w = await this.prisma.workerProfile.findUniqueOrThrow({
      where: { userId: workerId },
      select: {
        userId: true,
        verificationStatus: true,
        badge: true,
        rejectionReason: true,
      },
    });
    return w;
  }
}

export const workerNotFound = () =>
  new AppException('NOT_FOUND', 404, 'Worker not found');
