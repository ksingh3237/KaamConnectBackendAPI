import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { seedReferenceData } from '../prisma/seed/reference-data.js';
import { createTestPrisma, resetDatabase } from './helpers/db.js';
import {
  anyArea,
  bookingWindow,
  makeCustomer,
  makeJob,
  makeUser,
  makeWorker,
} from './helpers/factories.js';

// These tests prove the database itself enforces the rules in docs/02-database.md §5, so a bug
// in application code cannot corrupt data. They use the real *_test PostgreSQL database.
describe('database constraints', () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = createTestPrisma();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
    await seedReferenceData(prisma);
  });

  describe('worker profile', () => {
    it('accepts the radii the UI offers (3, 6, 12) and rejects others', async () => {
      for (const radiusKm of [3, 6, 12]) await makeWorker(prisma, { radiusKm });
      await expect(makeWorker(prisma, { radiusKm: 5 })).rejects.toThrow(
        /worker_profiles_radius_allowed/,
      );
    });

    it('limits experience to 1-40 years', async () => {
      await makeWorker(prisma, { experienceYears: 1 });
      await makeWorker(prisma, { experienceYears: 40 });
      await expect(makeWorker(prisma, { experienceYears: 0 })).rejects.toThrow(
        /worker_profiles_experience_range/,
      );
      await expect(makeWorker(prisma, { experienceYears: 41 })).rejects.toThrow(
        /worker_profiles_experience_range/,
      );
    });

    it('allows only one primary trade per worker', async () => {
      const worker = await makeWorker(prisma);
      await prisma.workerTrade.create({
        data: {
          workerId: worker.userId,
          categoryId: 'electrician',
          isPrimary: true,
        },
      });
      await prisma.workerTrade.create({
        data: {
          workerId: worker.userId,
          categoryId: 'appliance',
          isPrimary: false,
        },
      });
      await expect(
        prisma.workerTrade.create({
          data: {
            workerId: worker.userId,
            categoryId: 'plumber',
            isPrimary: true,
          },
        }),
      ).rejects.toThrow(/worker_trades_one_primary_per_worker/);
    });

    it('stores only one document of each type', async () => {
      const worker = await makeWorker(prisma);
      await prisma.workerDocument.create({
        data: {
          workerId: worker.userId,
          type: 'AADHAAR_FRONT',
          storageKey: 'k1',
        },
      });
      await expect(
        prisma.workerDocument.create({
          data: {
            workerId: worker.userId,
            type: 'AADHAAR_FRONT',
            storageKey: 'k2',
          },
        }),
      ).rejects.toThrow();
    });
  });

  describe('addresses', () => {
    it('allows only one primary address per customer, but many non-primary', async () => {
      const customer = await makeCustomer(prisma);
      const area = await anyArea(prisma);
      const base = {
        customerId: customer.userId,
        areaId: area.id,
        line: 'House 1',
      };
      await prisma.address.create({ data: { ...base, isPrimary: true } });
      await prisma.address.create({ data: { ...base, isPrimary: false } });
      await prisma.address.create({ data: { ...base, isPrimary: false } });
      await expect(
        prisma.address.create({ data: { ...base, isPrimary: true } }),
      ).rejects.toThrow(/addresses_one_primary_per_customer/);
    });

    it('rejects out-of-range coordinates', async () => {
      const customer = await makeCustomer(prisma);
      const area = await anyArea(prisma);
      await expect(
        prisma.address.create({
          data: {
            customerId: customer.userId,
            areaId: area.id,
            line: 'x',
            lat: 91,
            lng: 76,
          },
        }),
      ).rejects.toThrow(/addresses_coords_range/);
    });
  });

  describe('jobs', () => {
    it('numbers jobs from 10000 (KC-10000), also after a TRUNCATE ... RESTART IDENTITY', async () => {
      const customer = await makeCustomer(prisma);
      const first = await makeJob(prisma, customer.userId);
      const second = await makeJob(prisma, customer.userId);
      expect([first.jobNumber, second.jobNumber]).toEqual([10000, 10001]);

      await resetDatabase(prisma);
      await seedReferenceData(prisma);
      const again = await makeJob(prisma, (await makeCustomer(prisma)).userId);
      expect(again.jobNumber).toBe(10000);
    });

    it('does not allow an assigned job without a worker', async () => {
      const customer = await makeCustomer(prisma);
      await expect(
        makeJob(prisma, customer.userId, { status: 'ASSIGNED' }),
      ).rejects.toThrow(/jobs_assigned_has_worker/);

      const worker = await makeWorker(prisma);
      await expect(
        makeJob(prisma, customer.userId, {
          status: 'ASSIGNED',
          workerId: worker.userId,
        }),
      ).resolves.toBeTruthy();
    });

    it('requires who and when for a cancelled job', async () => {
      const customer = await makeCustomer(prisma);
      await expect(
        makeJob(prisma, customer.userId, { status: 'CANCELLED' }),
      ).rejects.toThrow(/jobs_cancelled_has_actor/);
      await expect(
        makeJob(prisma, customer.userId, {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancelledBy: 'CUSTOMER',
        }),
      ).resolves.toBeTruthy();
    });

    it('requires a 4-digit arrival code', async () => {
      const customer = await makeCustomer(prisma);
      const worker = await makeWorker(prisma);
      const assigned = { status: 'ASSIGNED', workerId: worker.userId } as const;
      await expect(
        makeJob(prisma, customer.userId, { ...assigned, arrivalCode: '8421' }),
      ).resolves.toBeTruthy();
      await expect(
        makeJob(prisma, customer.userId, { ...assigned, arrivalCode: '84a1' }),
      ).rejects.toThrow(/jobs_arrival_code_format/);
      await expect(
        makeJob(prisma, customer.userId, { ...assigned, arrivalCode: '842' }),
      ).rejects.toThrow(/jobs_arrival_code_format/);
    });

    it('rejects a job in an unknown service category', async () => {
      const customer = await makeCustomer(prisma);
      await expect(
        makeJob(prisma, customer.userId, { categoryId: 'astrology' }),
      ).rejects.toThrow();
    });
  });

  describe('offers', () => {
    it('keeps the fee within 1-100000 and the ETA within 5-240 minutes', async () => {
      const customer = await makeCustomer(prisma);
      const worker = await makeWorker(prisma);
      const job = await makeJob(prisma, customer.userId);
      const offer = (
        visitFee: number,
        etaMinutes: number,
        w = worker.userId,
        j = job.id,
      ) =>
        prisma.offer.create({
          data: { jobId: j, workerId: w, visitFee, etaMinutes },
        });

      await expect(offer(0, 15)).rejects.toThrow(/offers_fee_range/);
      await expect(offer(100001, 15)).rejects.toThrow(/offers_fee_range/);
      await expect(offer(250, 3)).rejects.toThrow(/offers_eta_range/);
      await expect(offer(250, 15)).resolves.toBeTruthy();
    });

    it('allows one quote per worker per job', async () => {
      const customer = await makeCustomer(prisma);
      const worker = await makeWorker(prisma);
      const job = await makeJob(prisma, customer.userId);
      const data = {
        jobId: job.id,
        workerId: worker.userId,
        visitFee: 250,
        etaMinutes: 15,
      };
      await prisma.offer.create({ data });
      await expect(prisma.offer.create({ data })).rejects.toThrow();

      const other = await makeWorker(prisma);
      await expect(
        prisma.offer.create({ data: { ...data, workerId: other.userId } }),
      ).resolves.toBeTruthy();
    });

    it('allows a job to point at only one accepted offer, and an offer to be accepted for only one job', async () => {
      const customer = await makeCustomer(prisma);
      const worker = await makeWorker(prisma);
      const jobA = await makeJob(prisma, customer.userId);
      const jobB = await makeJob(prisma, customer.userId);
      const offer = await prisma.offer.create({
        data: {
          jobId: jobA.id,
          workerId: worker.userId,
          visitFee: 250,
          etaMinutes: 15,
        },
      });
      await prisma.job.update({
        where: { id: jobA.id },
        data: {
          acceptedOfferId: offer.id,
          workerId: worker.userId,
          status: 'ASSIGNED',
          ...bookingWindow(0),
        },
      });
      // A different, non-overlapping window: the only thing wrong here is the reused accepted offer.
      await expect(
        prisma.job.update({
          where: { id: jobB.id },
          data: {
            acceptedOfferId: offer.id,
            workerId: worker.userId,
            status: 'ASSIGNED',
            ...bookingWindow(600),
          },
        }),
      ).rejects.toThrow(/accepted_offer_id/);
    });
  });

  describe('money and feedback', () => {
    it('rejects negative bill items and zero payments', async () => {
      const customer = await makeCustomer(prisma);
      const job = await makeJob(prisma, customer.userId);
      await expect(
        prisma.billItem.create({
          data: {
            jobId: job.id,
            kind: 'PARTS',
            description: 'Pipe',
            amount: -1,
          },
        }),
      ).rejects.toThrow(/bill_items_amount_nonneg/);
      await expect(
        prisma.billItem.create({
          data: {
            jobId: job.id,
            kind: 'VISIT_FEE',
            description: 'Visit',
            amount: 0,
          },
        }),
      ).resolves.toBeTruthy();
      await expect(
        prisma.payment.create({
          data: { jobId: job.id, method: 'UPI', amount: 0 },
        }),
      ).rejects.toThrow(/payments_amount_pos/);
    });

    it('allows one payment and one review per job, rated 1-5', async () => {
      const customer = await makeCustomer(prisma);
      const worker = await makeWorker(prisma);
      const job = await makeJob(prisma, customer.userId, {
        status: 'COMPLETED',
        workerId: worker.userId,
      });
      await prisma.payment.create({
        data: { jobId: job.id, method: 'CASH', amount: 430 },
      });
      await expect(
        prisma.payment.create({
          data: { jobId: job.id, method: 'UPI', amount: 430 },
        }),
      ).rejects.toThrow();

      const review = (rating: number) =>
        prisma.review.create({
          data: {
            jobId: job.id,
            customerId: customer.userId,
            workerId: worker.userId,
            rating,
            tags: ['PUNCTUAL'],
          },
        });
      await expect(review(0)).rejects.toThrow(/reviews_rating_range/);
      await expect(review(6)).rejects.toThrow(/reviews_rating_range/);
      await expect(review(5)).resolves.toBeTruthy();
      await expect(review(4)).rejects.toThrow();
    });
  });

  describe('arrival-code recovery (columns and the job_security_events audit table)', () => {
    async function assignedJob() {
      const customer = await makeCustomer(prisma);
      const worker = await makeWorker(prisma);
      const job = await makeJob(prisma, customer.userId, {
        status: 'ASSIGNED',
        workerId: worker.userId,
        arrivalCode: '4821',
      });
      return { customer, worker, job };
    }

    it('a job starts with no resets used and no cooldown', async () => {
      const { job } = await assignedJob();
      expect(job.arrivalCodeResets).toBe(0);
      expect(job.arrivalCodeResetAt).toBeNull();
    });

    it('the reset counter can never be negative (jobs_arrival_code_resets_nonneg)', async () => {
      const { job } = await assignedJob();
      await expect(
        prisma.job.update({
          where: { id: job.id },
          data: { arrivalCodeResets: -1 },
        }),
      ).rejects.toThrow(/jobs_arrival_code_resets_nonneg/);
      // The limit of 3 lives in code, not in the database, so 0 and larger values are accepted here.
      for (const value of [0, 3, 4]) {
        await expect(
          prisma.job.update({
            where: { id: job.id },
            data: { arrivalCodeResets: value },
          }),
        ).resolves.toBeTruthy();
      }
      expect(
        (await prisma.job.findUniqueOrThrow({ where: { id: job.id } }))
          .arrivalCodeResets,
      ).toBe(4);
    });

    it('an audit event needs an existing job (job_security_events_job_id_fkey)', async () => {
      await expect(
        prisma.jobSecurityEvent.create({
          data: {
            jobId: '0197a0c0-0000-7000-8000-000000000000',
            type: 'ARRIVAL_LOCKED',
          },
        }),
      ).rejects.toThrow(/job_security_events_job_id_fkey/);
    });

    it('a job that has audit events cannot be deleted: the trail is kept (ON DELETE RESTRICT)', async () => {
      const { customer, job } = await assignedJob();
      await prisma.jobSecurityEvent.create({
        data: {
          jobId: job.id,
          actorId: customer.userId,
          type: 'ARRIVAL_CODE_RESET',
          ip: '203.0.113.7',
        },
      });
      await expect(
        prisma.job.delete({ where: { id: job.id } }),
      ).rejects.toThrow(/job_security_events_job_id_fkey/);
      expect(await prisma.job.count({ where: { id: job.id } })).toBe(1);
      expect(
        await prisma.jobSecurityEvent.count({ where: { jobId: job.id } }),
      ).toBe(1);
    });

    it('deleting the person who acted keeps the audit row and blanks the actor (ON DELETE SET NULL)', async () => {
      const { job } = await assignedJob();
      const actor = await makeUser(prisma); // a bare user: no profile ties it to other rows
      const event = await prisma.jobSecurityEvent.create({
        data: {
          jobId: job.id,
          actorId: actor.id,
          type: 'ARRIVAL_RESET_REFUSED',
          detail: 'COOLDOWN',
        },
      });
      await prisma.user.delete({ where: { id: actor.id } });
      const kept = await prisma.jobSecurityEvent.findUniqueOrThrow({
        where: { id: event.id },
      });
      expect(kept).toMatchObject({
        jobId: job.id,
        actorId: null,
        type: 'ARRIVAL_RESET_REFUSED',
        detail: 'COOLDOWN',
      });
    });

    it('only the three known event types can be stored', async () => {
      const { job } = await assignedJob();
      for (const type of [
        'ARRIVAL_LOCKED',
        'ARRIVAL_CODE_RESET',
        'ARRIVAL_RESET_REFUSED',
      ] as const) {
        await prisma.jobSecurityEvent.create({ data: { jobId: job.id, type } });
      }
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO job_security_events (id, job_id, type) VALUES (gen_random_uuid(), '${job.id}', 'SOMETHING_ELSE')`,
        ),
      ).rejects.toThrow(/JobSecurityEventType/);
      expect(
        await prisma.jobSecurityEvent.count({ where: { jobId: job.id } }),
      ).toBe(3);
    });
  });

  describe('D-9 decision audit (worker_profiles.reviewed_at and reviewed_by)', () => {
    const MIGRATION = join(
      process.cwd(),
      'prisma/migrations/20261011200000_worker_review_audit/migration.sql',
    );
    /** The backfill is read from the migration file itself, so the test cannot drift from what is applied. */
    const backfill = () => {
      const sql = readFileSync(MIGRATION, 'utf8');
      const start = sql.indexOf('UPDATE "worker_profiles"');
      if (start < 0) throw new Error('no backfill UPDATE in the migration');
      return sql.slice(start, sql.indexOf(';', start) + 1);
    };
    const profile = (userId: string) =>
      prisma.workerProfile.findUniqueOrThrow({ where: { userId } });

    it('has the two columns: both nullable, no default, the right types', async () => {
      const rows = await prisma.$queryRaw<
        {
          column_name: string;
          data_type: string;
          is_nullable: string;
          column_default: string | null;
        }[]
      >`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_name = 'worker_profiles' AND column_name IN ('reviewed_at', 'reviewed_by')
        ORDER BY column_name`;
      expect(rows).toEqual([
        {
          column_name: 'reviewed_at',
          data_type: 'timestamp with time zone',
          is_nullable: 'YES',
          column_default: null,
        },
        {
          column_name: 'reviewed_by',
          data_type: 'uuid',
          is_nullable: 'YES',
          column_default: null,
        },
      ]);
    });

    it('a new worker has no decision recorded', async () => {
      const w = await makeWorker(prisma);
      expect(w.reviewedAt).toBeNull();
      expect(w.reviewedById).toBeNull();
    });

    it('records who decided and when, and refuses a reviewer who does not exist (worker_profiles_reviewed_by_fkey)', async () => {
      const admin = await makeUser(prisma);
      const w = await makeWorker(prisma);
      const at = new Date('2026-10-01T10:00:00.000Z');
      await prisma.workerProfile.update({
        where: { userId: w.userId },
        data: { reviewedAt: at, reviewedById: admin.id },
      });
      const stored = await profile(w.userId);
      expect(stored.reviewedAt).toEqual(at);
      expect(stored.reviewedById).toBe(admin.id);

      await expect(
        prisma.workerProfile.update({
          where: { userId: w.userId },
          data: { reviewedById: '0197a0c0-0000-7000-8000-000000000000' },
        }),
      ).rejects.toThrow(/worker_profiles_reviewed_by_fkey/);
    });

    it('removing the reviewer never removes or blocks the worker: reviewed_by becomes NULL, the time stays (ON DELETE SET NULL)', async () => {
      const admin = await makeUser(prisma);
      const w = await makeWorker(prisma);
      const at = new Date('2026-10-01T10:00:00.000Z');
      await prisma.workerProfile.update({
        where: { userId: w.userId },
        data: { reviewedAt: at, reviewedById: admin.id },
      });
      await prisma.user.delete({ where: { id: admin.id } });
      const stored = await profile(w.userId);
      expect(stored.reviewedById).toBeNull();
      expect(stored.reviewedAt).toEqual(at);
    });

    it('deleting the WORKER still cascades their profile as before (the second relation to users did not change it)', async () => {
      const w = await makeWorker(prisma);
      await prisma.user.delete({ where: { id: w.userId } });
      expect(
        await prisma.workerProfile.count({ where: { userId: w.userId } }),
      ).toBe(0);
    });

    describe('the backfill statement in the migration', () => {
      const decide = (
        userId: string,
        data: {
          verificationStatus: 'PENDING' | 'VERIFIED' | 'REJECTED';
          verifiedAt?: Date | null;
          reviewedAt?: Date | null;
        },
      ) =>
        prisma.workerProfile.update({
          where: { userId },
          data: { rejectionReason: null, ...data },
        });

      it('carries over a recorded approval time and invents nothing else', async () => {
        const approvedAt = new Date('2026-09-20T08:30:00.000Z');
        const approved = await makeWorker(prisma);
        const approvedNoTime = await makeWorker(prisma);
        const rejected = await makeWorker(prisma);
        const pending = await makeWorker(prisma);
        await decide(approved.userId, {
          verificationStatus: 'VERIFIED',
          verifiedAt: approvedAt,
        });
        await decide(approvedNoTime.userId, {
          verificationStatus: 'VERIFIED',
          verifiedAt: null,
        });
        await prisma.workerProfile.update({
          where: { userId: rejected.userId },
          data: {
            verificationStatus: 'REJECTED',
            rejectionReason: 'blurred photo',
          },
        });

        await prisma.$executeRawUnsafe(backfill());

        expect((await profile(approved.userId)).reviewedAt).toEqual(approvedAt);
        // No recorded time, so none is made up: these stay NULL (the sweep never deletes on NULL).
        expect((await profile(approvedNoTime.userId)).reviewedAt).toBeNull();
        expect((await profile(rejected.userId)).reviewedAt).toBeNull();
        expect((await profile(pending.userId)).reviewedAt).toBeNull();
      });

      it('never invents a reviewer: reviewed_by is NULL on every row afterwards', async () => {
        const a = await makeWorker(prisma);
        const b = await makeWorker(prisma);
        await decide(a.userId, {
          verificationStatus: 'VERIFIED',
          verifiedAt: new Date('2026-09-20T08:30:00.000Z'),
        });
        await decide(b.userId, { verificationStatus: 'REJECTED' });
        await prisma.$executeRawUnsafe(backfill());
        expect(
          await prisma.workerProfile.count({
            where: { reviewedById: { not: null } },
          }),
        ).toBe(0);
      });

      it('does not overwrite a decision time that is already set, and running it again changes nothing', async () => {
        const w = await makeWorker(prisma);
        const real = new Date('2026-10-05T12:00:00.000Z');
        await decide(w.userId, {
          verificationStatus: 'VERIFIED',
          verifiedAt: new Date('2026-09-20T08:30:00.000Z'),
          reviewedAt: real,
        });
        await prisma.$executeRawUnsafe(backfill());
        await prisma.$executeRawUnsafe(backfill());
        expect((await profile(w.userId)).reviewedAt).toEqual(real);
      });

      it('leaves a worker who went back to PENDING without a decision time', async () => {
        const w = await makeWorker(prisma);
        // verified_at is cleared when a profile returns to PENDING (D-8), so there is nothing to carry.
        await decide(w.userId, {
          verificationStatus: 'PENDING',
          verifiedAt: null,
        });
        await prisma.$executeRawUnsafe(backfill());
        expect((await profile(w.userId)).reviewedAt).toBeNull();
      });
    });
  });
});
