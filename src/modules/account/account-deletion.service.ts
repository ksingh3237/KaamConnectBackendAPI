import { Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../common/exceptions/app.exception.js';
import { referenceOf } from '../../common/utils/reference.js';
import type { Prisma } from '../../generated/prisma/client.js';
import {
  CancelledBy,
  JobStatus,
  Language,
  OfferStatus,
  SosStatus,
  VerificationStatus,
} from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { StorageService } from '../media/storage/storage.service.js';
import type { StorageBucket } from '../media/media-rules.js';
import { OtpService } from '../auth/otp.service.js';
import { RealtimeEvent } from '../realtime/events.js';
import { RealtimePublisher } from '../realtime/realtime-publisher.js';
import { DeletionLedger } from './deletion-ledger.js';

/**
 * A job in one of these statuses stops the account from being deleted (docs/08 section 1.2): somebody is waiting
 * for this person, or money has still to be recorded. COMPLETED and CANCELLED never block.
 */
export const BLOCKING_JOB_STATUSES: JobStatus[] = [
  JobStatus.OPEN,
  JobStatus.ASSIGNED,
  JobStatus.ARRIVED,
  JobStatus.IN_PROGRESS,
  JobStatus.WORK_COMPLETED,
];

export const DELETED_CUSTOMER_NAME = 'Deleted user';
export const DELETED_WORKER_NAME = 'Deleted worker';
export const REMOVED_ADDRESS = '(removed)';

type Actor = { kind: 'SELF' } | { kind: 'ADMIN'; adminId: string };
type Db = Prisma.TransactionClient | PrismaService;

export interface DeletionRequestItem {
  userId: string;
  requestedAt: string;
  phone: string;
  name: string | null;
  role: 'CUSTOMER' | 'WORKER' | 'BOTH' | 'NONE';
}

/**
 * Deletes an account by anonymising it: everything that identifies the person goes, the records the other party and
 * the business still need stay with the person shown as "Deleted user/worker" (docs/08 section 1). One operation,
 * reached through two doors: the person themself with a fresh OTP (`deleteOwn`), or an admin approving a request from
 * a disabled person (`approveRequest`). Safe to repeat: the second call finds the account already deleted.
 */
@Injectable()
export class AccountDeletionService {
  private readonly logger = new Logger(AccountDeletionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly otp: OtpService,
    private readonly storage: StorageService,
    private readonly publisher: RealtimePublisher,
    private readonly ledger: DeletionLedger,
  ) {}

  // ───────────────────────── Door A: the person, with a fresh code ─────────────────────────

  async deleteOwn(userId: string, code: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { phone: true, isAdmin: true, deletedAt: true },
    });
    if (!user || user.deletedAt)
      throw new AppException('UNAUTHENTICATED', 401, 'Authentication required');
    if (user.isAdmin) throw adminCannotDelete();

    // Cheap refusals first, so a person with a job in progress does not spend a code attempt
    await this.assertNoBlockers(this.prisma, userId);

    // The code proves control of the phone number (the session alone, e.g. a stolen token, is not enough).
    // It is spent in the same transaction that anonymises, so a failed attempt (storage down) can be retried.
    const challengeId = await this.otp.check(user.phone, code);
    await this.anonymise(userId, { kind: 'SELF' }, challengeId);
  }

  // ───────────────────────── Door B: a disabled person asks, an admin decides ─────────────────────────

  /**
   * Records that the holder of this number asked for deletion. Answers nothing about whether an account exists:
   * the caller always gets the same reply. Does NOT delete: a disabled account may be under investigation.
   */
  async requestAsDisabled(phone: string, code: string): Promise<void> {
    const challengeId = await this.otp.check(phone, code);
    await this.prisma.otpChallenge.updateMany({
      where: { id: challengeId, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    const marked = await this.prisma.user.updateMany({
      where: {
        phone,
        isActive: false,
        isAdmin: false,
        deletedAt: null,
        deletionRequestedAt: null,
      },
      data: { deletionRequestedAt: new Date() },
    });
    if (marked.count === 1)
      this.logger.log('A deletion request was recorded for a disabled account');
  }

  async listRequests(): Promise<{ items: DeletionRequestItem[] }> {
    const users = await this.prisma.user.findMany({
      where: { deletionRequestedAt: { not: null }, deletedAt: null },
      orderBy: { deletionRequestedAt: 'asc' },
      take: 100,
      select: {
        id: true,
        phone: true,
        deletionRequestedAt: true,
        customer: { select: { fullName: true } },
        worker: { select: { fullName: true } },
      },
    });
    return {
      items: users.map((u) => ({
        userId: u.id,
        requestedAt: u.deletionRequestedAt!.toISOString(),
        phone: u.phone,
        name: u.customer?.fullName ?? u.worker?.fullName ?? null,
        role:
          u.customer && u.worker
            ? 'BOTH'
            : u.customer
              ? 'CUSTOMER'
              : u.worker
                ? 'WORKER'
                : 'NONE',
      })),
    };
  }

  async approveRequest(adminId: string, userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { deletionRequestedAt: true, deletedAt: true, isAdmin: true },
    });
    if (!user || (!user.deletionRequestedAt && !user.deletedAt))
      throw new AppException('NOT_FOUND', 404, 'No such deletion request');
    if (user.isAdmin) throw adminCannotDelete();
    await this.anonymise(userId, { kind: 'ADMIN', adminId });
  }

  async declineRequest(adminId: string, userId: string): Promise<void> {
    const cleared = await this.prisma.user.updateMany({
      where: {
        id: userId,
        deletionRequestedAt: { not: null },
        deletedAt: null,
      },
      data: { deletionRequestedAt: null },
    });
    if (cleared.count !== 1)
      throw new AppException('NOT_FOUND', 404, 'No such deletion request');
    this.logger.warn(
      `Deletion request of user ${userId} declined by admin ${adminId}`,
    );
  }

  // ───────────────────────── The operation ─────────────────────────

  /**
   * Re-runs deletion for an id from the ledger after a backup restore (docs/08 section 1.5). Operator use only; it
   * performs the same anonymisation without an OTP, so it is never reachable over HTTP.
   */
  async reapplyFromLedger(userId: string): Promise<'deleted' | 'already'> {
    return this.anonymise(userId, { kind: 'ADMIN', adminId: 'ledger-reapply' });
  }

  private async anonymise(
    userId: string,
    actor: Actor,
    challengeId?: string,
  ): Promise<'deleted' | 'already'> {
    const before = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        deletedAt: true,
        customer: { select: { photoKey: true } },
        worker: {
          select: {
            photoKey: true,
            documents: { select: { storageKey: true } },
          },
        },
      },
    });
    if (!before) throw new AppException('NOT_FOUND', 404, 'Account not found');
    if (before.deletedAt) return 'already';

    // 1. Files first (docs/08 s1.3): if storage is unreachable nothing else has changed and the call can be repeated.
    const jobMedia = await this.prisma.jobMedia.findMany({
      where: { job: { customerId: userId } },
      select: { storageKey: true },
    });
    const objects: { bucket: StorageBucket; key: string }[] = [
      ...(before.customer?.photoKey
        ? [{ bucket: 'media' as const, key: before.customer.photoKey }]
        : []),
      ...(before.worker?.photoKey
        ? [{ bucket: 'media' as const, key: before.worker.photoKey }]
        : []),
      ...(before.worker?.documents ?? []).map((d) => ({
        bucket: 'private' as const,
        key: d.storageKey,
      })),
      ...jobMedia.map((m) => ({ bucket: 'media' as const, key: m.storageKey })),
    ];
    try {
      for (const o of objects) await this.storage.delete(o.bucket, o.key);
    } catch (error) {
      this.logger.error(
        `Account deletion of ${userId} stopped: storage failed (${error instanceof Error ? error.message : String(error)})`,
      );
      throw new AppException(
        'STORAGE_UNAVAILABLE',
        502,
        'Could not remove your files right now; nothing was deleted. Please try again.',
      );
    }

    // 2. The rows, in one transaction.
    const declinedDirect = await this.prisma.$transaction(
      async (tx) => {
        // Same per-person lock the booking code takes before it hands a job to a worker (AvailabilityService.reserve).
        // Whichever side gets it first wins; the other re-reads and sees the result.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`booking:${userId}`}))`;
        const locked = await tx.$queryRaw<
          { phone: string; deleted_at: Date | null; is_admin: boolean }[]
        >`SELECT phone, deleted_at, is_admin FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
        const row = locked[0];
        if (!row) throw new AppException('NOT_FOUND', 404, 'Account not found');
        if (row.deleted_at) return null; // a simultaneous call finished first
        if (row.is_admin) throw adminCannotDelete();

        await this.assertNoBlockers(tx, userId);

        if (challengeId) {
          const spent = await tx.otpChallenge.updateMany({
            where: { id: challengeId, consumedAt: null },
            data: { consumedAt: new Date() },
          });
          if (spent.count !== 1)
            throw new AppException(
              'OTP_INVALID',
              401,
              'The code is incorrect or has expired',
            );
        }

        return this.anonymiseRows(tx, userId, row.phone);
      },
      { timeout: 20_000 },
    );
    if (declinedDirect === null) return 'already';

    // 3. After commit: tell people, close connections, record it.
    for (const job of declinedDirect) {
      this.publisher.toUser(job.customerId, RealtimeEvent.DIRECT_DECLINED, {
        jobId: job.id,
      });
    }
    this.publisher.disconnectUser(userId);
    try {
      await this.ledger.append({
        userId,
        at: new Date().toISOString(),
        actor: actor.kind,
      });
    } catch (error) {
      // The deletion itself is done and cannot be undone; make the missing record impossible to overlook.
      this.logger.error(
        `Account ${userId} was deleted but the ledger entry could not be written: ${error instanceof Error ? error.message : String(error)}. Add it by hand.`,
      );
    }
    this.logger.log(
      `Account ${userId} deleted${actor.kind === 'ADMIN' ? ` (approved by admin ${actor.adminId})` : ''}`,
    );
    return 'deleted';
  }

  private async anonymiseRows(
    tx: Prisma.TransactionClient,
    userId: string,
    oldPhone: string,
  ): Promise<{ id: string; customerId: string }[]> {
    const now = new Date();
    // 15 characters: "del" + the last 12 hex digits of the id (the random part of a UUIDv7), unique and fits the column
    const tombstone = `del${userId.replace(/-/g, '').slice(-12)}`;

    await tx.refreshToken.deleteMany({ where: { userId } });
    await tx.deviceToken.deleteMany({ where: { userId } });
    await tx.inAppNotification.deleteMany({ where: { userId } });
    await tx.otpChallenge.deleteMany({ where: { phone: oldPhone } });

    // customer side: the home, the pictures of it and the name
    await tx.address.deleteMany({ where: { customerId: userId } });
    await tx.jobMedia.deleteMany({ where: { job: { customerId: userId } } });
    await tx.job.updateMany({
      where: { customerId: userId },
      data: {
        addressLine: REMOVED_ADDRESS,
        lat: null,
        lng: null,
        description: null,
        arrivalCode: null,
      },
    });
    await tx.customerProfile.updateMany({
      where: { userId },
      data: {
        fullName: DELETED_CUSTOMER_NAME,
        photoKey: null,
        commLanguage: Language.hi,
        allowDirectCalls: true,
      },
    });

    // worker side: payment details, documents, location. REJECTED keeps them undiscoverable and un-bookable (K-36).
    await tx.workerProfile.updateMany({
      where: { userId },
      data: {
        fullName: DELETED_WORKER_NAME,
        photoKey: null,
        upiId: null,
        vehicle: null,
        addressLine: null,
        localityName: null,
        isAvailable: false,
        badge: null,
        rejectionReason: null,
        skills: [],
        languages: [],
        visitingFee: null,
        verificationStatus: VerificationStatus.REJECTED,
      },
    });
    await tx.workerDocument.deleteMany({ where: { workerId: userId } });
    await tx.workerLocation.deleteMany({ where: { workerId: userId } });
    await tx.workerTrade.deleteMany({ where: { workerId: userId } });
    await tx.workerLead.deleteMany({ where: { workerId: userId } });
    await tx.offer.updateMany({
      where: { workerId: userId, status: OfferStatus.PENDING },
      data: { status: OfferStatus.WITHDRAWN },
    });
    await tx.offer.updateMany({
      where: { workerId: userId },
      data: { message: null },
    });
    // "Book Pro" requests addressed to this worker cannot be answered any more: decline them like the worker would.
    const direct = await tx.job.findMany({
      where: { targetWorkerId: userId, status: JobStatus.OPEN },
      select: { id: true, customerId: true },
    });
    if (direct.length > 0) {
      await tx.job.updateMany({
        where: { id: { in: direct.map((j) => j.id) }, status: JobStatus.OPEN },
        data: {
          status: JobStatus.CANCELLED,
          cancelledAt: now,
          cancelledBy: CancelledBy.WORKER,
          cancelReason: 'DECLINED',
        },
      });
    }

    // audit trail kept without the network address; safety records kept without the personal details they carried
    await tx.jobSecurityEvent.updateMany({
      where: { actorId: userId },
      data: { ip: null },
    });
    await tx.$executeRaw`
      UPDATE sos_alerts SET payload = NULL
      WHERE delivered_at IS NOT NULL
        AND (user_id = ${userId}::uuid
             OR job_id IN (SELECT id FROM jobs WHERE customer_id = ${userId}::uuid OR worker_id = ${userId}::uuid))`;

    await tx.user.update({
      where: { id: userId },
      data: {
        phone: tombstone,
        language: Language.en,
        isActive: false,
        isAdmin: false,
        deletedAt: now,
        deletionRequestedAt: null,
      },
    });
    return direct;
  }

  /** Throws 409 listing the person's own jobs (and an open SOS) that block deletion. Reads only. */
  private async assertNoBlockers(db: Db, userId: string): Promise<void> {
    const jobs = await db.job.findMany({
      where: {
        status: { in: BLOCKING_JOB_STATUSES },
        OR: [{ customerId: userId }, { workerId: userId }],
      },
      select: { id: true, jobNumber: true, status: true, customerId: true },
      orderBy: { createdAt: 'asc' },
      take: 20,
    });
    const openSos = await db.sosAlert.count({
      where: { userId, status: SosStatus.OPEN },
    });
    if (jobs.length === 0 && openSos === 0) return;
    throw new AppException(
      'ACTIVE_JOB_BLOCKS_DELETION',
      409,
      'Finish or cancel your active jobs before deleting your account',
      [
        ...jobs.map((j) => ({
          field: `job:${j.id}`,
          issue: `${referenceOf(j.jobNumber)} is ${j.status} (you are the ${j.customerId === userId ? 'customer' : 'worker'})`,
        })),
        ...(openSos > 0
          ? [{ field: 'sos', issue: 'an SOS alert of yours is still open' }]
          : []),
      ],
    );
  }
}

const adminCannotDelete = () =>
  new AppException(
    'ADMIN_CANNOT_DELETE_SELF',
    409,
    'An admin account cannot be deleted this way; another admin must remove its admin rights first',
  );
