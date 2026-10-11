import type { PrismaClient } from '../src/generated/prisma/client.js';
import { seedReferenceData } from '../prisma/seed/reference-data.js';
import { createTestPrisma, resetDatabase } from './helpers/db.js';
import {
  anyArea,
  bookingWindow,
  makeCustomer,
  makeJob,
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
});
