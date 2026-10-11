import request from 'supertest';
import { JobExpiryService } from '../src/modules/jobs/job-expiry.service.js';
import { seedReferenceData } from '../prisma/seed/reference-data.js';
import { api, createTestApp, freshIp, type TestApp } from './helpers/app.js';
import { resetDatabase } from './helpers/db.js';
import { bookingWindow } from './helpers/factories.js';
import {
  customerIn,
  giveCoordinates,
  postJob,
  sendQuote,
  verifiedWorkerIn,
} from './helpers/marketplace.js';
import {
  newUser,
  uploadFile,
  workerPayload,
  anAreaId,
} from './helpers/personas.js';

const V1 = '/api/v1';
const JOBS = `${V1}/jobs`;
const MY_JOBS = `${V1}/customers/me/jobs`;

describe('jobs: posting, reading, listing, cancelling, expiry (e2e, real PostgreSQL)', () => {
  let t: TestApp;
  let http: ReturnType<typeof api>;

  beforeAll(async () => {
    t = await createTestApp();
    http = api(t.app);
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    await seedReferenceData(t.prisma);
  });

  describe('POST /jobs', () => {
    it('creates an OPEN job numbered from KC-10000 and tells how many workers were notified', async () => {
      const customer = await customerIn(t);
      await verifiedWorkerIn(t);
      await verifiedWorkerIn(t);

      const job = await postJob(t, customer);

      expect(job).toMatchObject({
        jobNumber: 10000,
        reference: 'KC-10000',
        status: 'OPEN',
        notifiedWorkers: 2,
      });
      const ttlHours =
        (new Date(job.expiresAt).getTime() - Date.now()) / 3_600_000;
      expect(ttlHours).toBeGreaterThan(23.9);
      expect(ttlHours).toBeLessThan(24.1);

      const second = await postJob(t, customer);
      expect(second.jobNumber).toBe(10001);
    });

    it('counts only verified workers of that trade who serve the place (and never the customer themself)', async () => {
      const customer = await customerIn(t, 'Sector 22');
      await verifiedWorkerIn(t, { trades: ['plumber'] }); // yes
      await verifiedWorkerIn(t, { trades: ['plumber', 'electrician'] }); // yes
      await verifiedWorkerIn(t, { trades: ['electrician'] }); // wrong trade
      await verifiedWorkerIn(t, { trades: ['plumber'], verified: false }); // not verified
      await verifiedWorkerIn(t, {
        trades: ['plumber'],
        area: 'Phase 7',
        city: 'Mohali (SAS Nagar)',
      }); // other city

      // A customer who is also a plumber must not be told about their own job.
      await t.prisma.workerProfile.create({
        data: {
          userId: customer.userId,
          fullName: 'Dual Role',
          baseAreaId: customer.areaId,
          experienceYears: 3,
          languages: ['hi'],
          termsAcceptedAt: new Date(),
          verificationStatus: 'VERIFIED',
          trades: { create: [{ categoryId: 'plumber', isPrimary: true }] },
        },
      });

      expect((await postJob(t, customer)).notifiedWorkers).toBe(2);
    });

    it("with coordinates, uses each worker's own radius", async () => {
      await giveCoordinates(t, 'Sector 22');
      await giveCoordinates(t, 'Sector 35');
      await giveCoordinates(t, 'Phase 7', 'Mohali (SAS Nagar)');
      const customer = await customerIn(t, 'Sector 22');
      await verifiedWorkerIn(t, { area: 'Sector 35', radiusKm: 3 }); // about 2.3 km: yes
      await verifiedWorkerIn(t, {
        area: 'Phase 7',
        city: 'Mohali (SAS Nagar)',
        radiusKm: 3,
      }); // about 6.4 km: no
      await verifiedWorkerIn(t, {
        area: 'Phase 7',
        city: 'Mohali (SAS Nagar)',
        radiusKm: 12,
      }); // yes

      expect((await postJob(t, customer)).notifiedWorkers).toBe(2);
    });

    it('can use a one-off address, and copies the address onto the job (later edits do not change it)', async () => {
      const customer = await customerIn(t);
      const area = await anAreaId(t);
      const job = await postJob(t, customer, {
        addressId: undefined,
        address: { areaId: area, line: 'Flat 9, Rose Apartments' },
      });

      let view = await http
        .get(`${JOBS}/${job.id}`, { token: customer.accessToken })
        .expect(200);
      expect(view.body.addressLine).toBe('Flat 9, Rose Apartments');

      const saved = await postJob(t, customer);
      await http
        .patch(
          `${V1}/customers/me/addresses/${customer.addressId}`,
          { line: 'Moved to a new house' },
          { token: customer.accessToken },
        )
        .expect(200);
      view = await http
        .get(`${JOBS}/${saved.id}`, { token: customer.accessToken })
        .expect(200);
      expect(view.body.addressLine).toBe('House #1402, Near Subhash Park');
    });

    it('stores photos and a voice note and returns working links', async () => {
      const customer = await customerIn(t);
      const photo = await uploadFile(t, customer.accessToken, 'JOB_PHOTO');
      const voice = await uploadFile(t, customer.accessToken, 'JOB_VOICE');
      const job = await postJob(t, customer, {
        photoKeys: [photo.key],
        voiceNote: { key: voice.key, durationSec: 14 },
      });

      const view = await http
        .get(`${JOBS}/${job.id}`, { token: customer.accessToken })
        .expect(200);
      expect(view.body.photoUrls).toHaveLength(1);
      expect(view.body.voiceNote).toMatchObject({ durationSec: 14 });
      const url = new URL(view.body.voiceNote.url);
      await request(t.app.getHttpServer())
        .get(url.pathname + url.search)
        .set('X-Forwarded-For', freshIp())
        .expect(200);
    });

    it.each([
      ['an unknown category', { categoryId: 'astrology' }, 'categoryId'],
      ['a blank title', { title: '   ' }, 'title'],
      ['a 121-character title', { title: 'x'.repeat(121) }, 'title'],
      [
        'a 1001-character description',
        { description: 'x'.repeat(1001) },
        'description',
      ],
      ['an unknown timing', { timing: 'NEXT_WEEK' }, 'timing'],
      [
        'both an address id and an address',
        { address: { areaId: 1, line: 'House 1' } },
        'addressId',
      ],
      ['neither address nor address id', { addressId: undefined }, 'addressId'],
      [
        'an address id that is not theirs',
        { addressId: '018f0000-0000-7000-8000-000000000000' },
        'addressId',
      ],
      [
        'six photos',
        { photoKeys: ['a', 'b', 'c', 'd', 'e', 'f'] },
        'photoKeys',
      ],
      ['a repeated photo', { photoKeys: ['a', 'a'] }, 'photoKeys'],
      [
        'a 31-second voice note',
        { voiceNote: { key: 'x', durationSec: 31 } },
        'voiceNote.durationSec',
      ],
      [
        'a 0-second voice note',
        { voiceNote: { key: 'x', durationSec: 0 } },
        'voiceNote.durationSec',
      ],
    ])(
      'rejects %s with a 422 naming the field',
      async (_label, overrides, field) => {
        const customer = await customerIn(t);
        const res = await http
          .post(
            JOBS,
            {
              categoryId: 'plumber',
              title: 'Leak',
              timing: 'IMMEDIATE',
              addressId: customer.addressId,
              ...overrides,
            },
            { token: customer.accessToken },
          )
          .expect(422);
        expect(res.body.code).toBe('VALIDATION_FAILED');
        expect(
          res.body.details.map((d: { field: string }) => d.field),
        ).toContain(field);
        expect(await t.prisma.job.count()).toBe(0);
      },
    );

    it('rejects an inactive category and an unknown one-off area', async () => {
      const customer = await customerIn(t);
      await t.prisma.serviceCategory.update({
        where: { id: 'plumber' },
        data: { isActive: false },
      });
      await http
        .post(
          JOBS,
          {
            categoryId: 'plumber',
            title: 'Leak',
            timing: 'IMMEDIATE',
            addressId: customer.addressId,
          },
          { token: customer.accessToken },
        )
        .expect(422);
      await t.prisma.serviceCategory.update({
        where: { id: 'plumber' },
        data: { isActive: true },
      });
      await http
        .post(
          JOBS,
          {
            categoryId: 'plumber',
            title: 'Leak',
            timing: 'IMMEDIATE',
            address: { areaId: 999999, line: 'House 1' },
          },
          { token: customer.accessToken },
        )
        .expect(422);
    });

    it("rejects media keys that are not the customer's own upload for that purpose", async () => {
      const customer = await customerIn(t);
      const other = await newUser(t);
      const foreign = await uploadFile(t, other.accessToken, 'JOB_PHOTO');
      const wrongPurpose = await uploadFile(
        t,
        customer.accessToken,
        'PROFILE_PHOTO',
      );
      const voiceAsPhoto = await uploadFile(
        t,
        customer.accessToken,
        'JOB_VOICE',
      );
      const missing = `u/${customer.userId}/JOB_PHOTO/00000000-0000-4000-8000-000000000000.jpg`;

      for (const key of [
        foreign.key,
        wrongPurpose.key,
        voiceAsPhoto.key,
        missing,
        '../../x',
      ]) {
        const res = await http
          .post(
            JOBS,
            {
              categoryId: 'plumber',
              title: 'Leak',
              timing: 'IMMEDIATE',
              addressId: customer.addressId,
              photoKeys: [key],
            },
            { token: customer.accessToken },
          )
          .expect(422);
        expect(res.body.details[0].field).toBe('photoKeys.0');
      }
      expect(await t.prisma.job.count()).toBe(0);
    });

    it('refuses fields the client must not set (status, worker, expiry, number)', async () => {
      const customer = await customerIn(t);
      const res = await http
        .post(
          JOBS,
          {
            categoryId: 'plumber',
            title: 'Leak',
            timing: 'IMMEDIATE',
            addressId: customer.addressId,
            status: 'COMPLETED',
            workerId: customer.userId,
            jobNumber: 1,
            expiresAt: '2030-01-01',
            customerId: customer.userId,
          },
          { token: customer.accessToken },
        )
        .expect(422);
      expect(
        res.body.details.map((d: { field: string }) => d.field).sort(),
      ).toEqual(['customerId', 'expiresAt', 'jobNumber', 'status', 'workerId']);
    });

    it('limits a customer to 10 open requests', async () => {
      const customer = await customerIn(t);
      for (let i = 0; i < 10; i += 1) await postJob(t, customer);
      const res = await http
        .post(
          JOBS,
          {
            categoryId: 'plumber',
            title: 'One more',
            timing: 'IMMEDIATE',
            addressId: customer.addressId,
          },
          { token: customer.accessToken },
        )
        .expect(409);
      expect(res.body.code).toBe('JOB_LIMIT');
    });

    it('needs a customer profile and a login', async () => {
      const workerOnly = await verifiedWorkerIn(t);
      const res = await http
        .post(
          JOBS,
          { categoryId: 'plumber', title: 'x', timing: 'IMMEDIATE' },
          { token: workerOnly.accessToken },
        )
        .expect(403);
      expect(res.body.code).toBe('CUSTOMER_PROFILE_REQUIRED');
      await http.post(JOBS, {}).expect(401);
    });
  });

  describe('GET /jobs/:id (who sees what)', () => {
    it('shows the customer everything about their own job', async () => {
      const customer = await customerIn(t);
      const job = await postJob(t, customer);
      const res = await http
        .get(`${JOBS}/${job.id}`, { token: customer.accessToken })
        .expect(200);

      expect(res.body).toMatchObject({
        id: job.id,
        reference: 'KC-10000',
        status: 'OPEN',
        title: 'Kitchen sink pipe burst',
        timing: 'IMMEDIATE',
        category: { id: 'plumber', title: { en: 'Plumber' } },
        area: { name: 'Sector 22' },
        city: { name: 'Chandigarh' },
        isDirect: false,
        viewer: 'customer',
        addressLine: 'House #1402, Near Subhash Park',
        offersCount: 0,
      });
      expect(res.body).not.toHaveProperty('arrivalCode');
      expect(res.body).not.toHaveProperty('worker');
    });

    it('is a plain 404 for other customers, workers who are not involved, and unknown ids', async () => {
      const customer = await customerIn(t);
      const stranger = await customerIn(t);
      const bystander = await verifiedWorkerIn(t);
      const job = await postJob(t, customer);

      for (const token of [stranger.accessToken, bystander.accessToken]) {
        const res = await http.get(`${JOBS}/${job.id}`, { token }).expect(404);
        expect(res.body.code).toBe('NOT_FOUND');
      }
      await http
        .get(`${JOBS}/018f0000-0000-7000-8000-000000000000`, {
          token: customer.accessToken,
        })
        .expect(404);
      await http
        .get(`${JOBS}/not-a-uuid`, { token: customer.accessToken })
        .expect(400);
      await http.get(`${JOBS}/${job.id}`).expect(401);
    });

    it('shows the assigned worker the address, but not the arrival code; the customer sees the code and the worker', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t, {
        fullName: 'Rajesh Kumar',
        visitingFee: 220,
      });
      const job = await postJob(t, customer);
      const quote = await sendQuote(t, worker, job.id);
      const accepted = await http
        .post(
          `${JOBS}/${job.id}/offers/${quote.id}/accept`,
          {},
          { token: customer.accessToken },
        )
        .expect(200);
      expect(accepted.body.arrivalCode).toMatch(/^\d{4}$/);

      const forWorker = await http
        .get(`${JOBS}/${job.id}`, { token: worker.accessToken })
        .expect(200);
      expect(forWorker.body).toMatchObject({
        viewer: 'worker',
        status: 'ASSIGNED',
        addressLine: 'House #1402, Near Subhash Park',
      });
      expect(forWorker.body).not.toHaveProperty('arrivalCode');
      expect(forWorker.body.customer).toMatchObject({ name: 'Sunita Sharma' });

      const forCustomer = await http
        .get(`${JOBS}/${job.id}`, { token: customer.accessToken })
        .expect(200);
      expect(forCustomer.body.arrivalCode).toBe(accepted.body.arrivalCode);
      expect(forCustomer.body.worker).toMatchObject({
        id: worker.userId,
        name: 'Rajesh Kumar',
        phone: worker.phone,
        visitingFee: 220,
      });
    });

    it("gives the worker the customer's phone only while in service and only if the customer allows calls", async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const job = await postJob(t, customer);
      const quote = await sendQuote(t, worker, job.id);
      await http
        .post(
          `${JOBS}/${job.id}/offers/${quote.id}/accept`,
          {},
          { token: customer.accessToken },
        )
        .expect(200);

      const phoneOf = async () =>
        (
          await http
            .get(`${JOBS}/${job.id}`, { token: worker.accessToken })
            .expect(200)
        ).body.customer.phone;
      expect(await phoneOf()).toBe(customer.phone);

      await http
        .patch(
          `${V1}/customers/me`,
          { allowDirectCalls: false },
          { token: customer.accessToken },
        )
        .expect(200);
      expect(await phoneOf()).toBeNull();
    });
  });

  describe('GET /customers/me/jobs (Activity)', () => {
    it('splits jobs into Ongoing / Completed / Cancelled and reports all three counts', async () => {
      const customer = await customerIn(t);
      const ongoing = await postJob(t, customer);
      const cancelled = await postJob(t, customer);
      await http
        .post(
          `${JOBS}/${cancelled.id}/cancel`,
          {},
          { token: customer.accessToken },
        )
        .expect(200);
      const worker = await verifiedWorkerIn(t);
      const done = await postJob(t, customer);
      await t.prisma.job.update({
        where: { id: done.id },
        data: {
          status: 'COMPLETED',
          workerId: worker.userId,
          completedAt: new Date(),
          ...bookingWindow(),
        },
      });

      const idsOf = async (tab?: string) => {
        const res = await http
          .get(`${MY_JOBS}${tab ? `?tab=${tab}` : ''}`, {
            token: customer.accessToken,
          })
          .expect(200);
        expect(res.body.meta.counts).toEqual({
          ongoing: 1,
          completed: 1,
          cancelled: 1,
        });
        return res.body.items.map((i: { id: string }) => i.id);
      };
      expect(await idsOf()).toEqual([ongoing.id]); // default tab
      expect(await idsOf('ongoing')).toEqual([ongoing.id]);
      expect(await idsOf('completed')).toEqual([done.id]);
      expect(await idsOf('cancelled')).toEqual([cancelled.id]);
    });

    it('describes each row for the card (number, trade, place, quotes, assigned worker)', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t, { fullName: 'Gurpreet Singh' });
      const job = await postJob(t, customer);
      const quote = await sendQuote(t, worker, job.id);

      let res = await http
        .get(MY_JOBS, { token: customer.accessToken })
        .expect(200);
      expect(res.body.items[0]).toMatchObject({
        id: job.id,
        reference: 'KC-10000',
        title: 'Kitchen sink pipe burst',
        status: 'OPEN',
        category: { id: 'plumber', title: 'Plumber' },
        area: 'Sector 22',
        city: 'Chandigarh',
        offersCount: 1,
        isDirect: false,
        worker: null,
      });

      await http
        .post(
          `${JOBS}/${job.id}/offers/${quote.id}/accept`,
          {},
          { token: customer.accessToken },
        )
        .expect(200);
      res = await http
        .get(MY_JOBS, { token: customer.accessToken })
        .expect(200);
      expect(res.body.items[0]).toMatchObject({
        status: 'ASSIGNED',
        worker: {
          id: worker.userId,
          name: 'Gurpreet Singh',
          phone: worker.phone,
        },
      });
    });

    it('pages newest first without gaps or repeats', async () => {
      const customer = await customerIn(t);
      const created: string[] = [];
      for (let i = 0; i < 5; i += 1)
        created.unshift((await postJob(t, customer)).id);

      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const res: request.Response = await http
          .get(`${MY_JOBS}?limit=2${cursor ? `&cursor=${cursor}` : ''}`, {
            token: customer.accessToken,
          })
          .expect(200);
        seen.push(...res.body.items.map((i: { id: string }) => i.id));
        cursor = res.body.nextCursor;
        pages += 1;
      } while (cursor && pages < 10);

      expect(pages).toBe(3);
      expect(seen).toEqual(created);
    });

    it("lists only the caller's own jobs", async () => {
      const alice = await customerIn(t);
      const bob = await customerIn(t);
      await postJob(t, alice);
      const bobJob = await postJob(t, bob);
      const res = await http
        .get(MY_JOBS, { token: bob.accessToken })
        .expect(200);
      expect(res.body.items.map((i: { id: string }) => i.id)).toEqual([
        bobJob.id,
      ]);
      expect(res.body.meta.counts.ongoing).toBe(1);
    });

    it('is empty for a new customer and rejects bad paging input', async () => {
      const customer = await customerIn(t);
      const empty = await http
        .get(MY_JOBS, { token: customer.accessToken })
        .expect(200);
      expect(empty.body).toEqual({
        items: [],
        nextCursor: null,
        meta: { counts: { ongoing: 0, completed: 0, cancelled: 0 } },
      });

      await http
        .get(`${MY_JOBS}?tab=archived`, { token: customer.accessToken })
        .expect(422);
      await http
        .get(`${MY_JOBS}?limit=0`, { token: customer.accessToken })
        .expect(422);
      await http
        .get(`${MY_JOBS}?limit=51`, { token: customer.accessToken })
        .expect(422);
      await http
        .get(`${MY_JOBS}?cursor=junk`, { token: customer.accessToken })
        .expect(422);
    });

    it('needs a customer profile', async () => {
      const workerOnly = await verifiedWorkerIn(t);
      await http.get(MY_JOBS, { token: workerOnly.accessToken }).expect(403);
    });
  });

  describe('POST /jobs/:id/cancel', () => {
    it('cancels an open job, records who and why, and rejects waiting quotes', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const job = await postJob(t, customer);
      await sendQuote(t, worker, job.id);

      const res = await http
        .post(
          `${JOBS}/${job.id}/cancel`,
          { reason: '  Fixed it myself  ' },
          { token: customer.accessToken },
        )
        .expect(200);
      expect(res.body).toMatchObject({
        status: 'CANCELLED',
        cancelledBy: 'CUSTOMER',
        cancelReason: 'Fixed it myself',
      });
      expect(res.body.cancelledAt).toBeTruthy();
      expect(
        (await t.prisma.offer.findFirstOrThrow({ where: { jobId: job.id } }))
          .status,
      ).toBe('REJECTED');
    });

    it('also works after a worker was assigned, and lets the worker see it', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const job = await postJob(t, customer);
      const quote = await sendQuote(t, worker, job.id);
      await http
        .post(
          `${JOBS}/${job.id}/offers/${quote.id}/accept`,
          {},
          { token: customer.accessToken },
        )
        .expect(200);

      await http
        .post(`${JOBS}/${job.id}/cancel`, {}, { token: customer.accessToken })
        .expect(200);
      const seen = await http
        .get(`${JOBS}/${job.id}`, { token: worker.accessToken })
        .expect(200);
      expect(seen.body).toMatchObject({
        status: 'CANCELLED',
        cancelledBy: 'CUSTOMER',
      });
    });

    it('refuses a second cancel, and cancelling once the worker has arrived', async () => {
      const customer = await customerIn(t);
      const job = await postJob(t, customer);
      await http
        .post(`${JOBS}/${job.id}/cancel`, {}, { token: customer.accessToken })
        .expect(200);
      const again = await http
        .post(`${JOBS}/${job.id}/cancel`, {}, { token: customer.accessToken })
        .expect(409);
      expect(again.body.code).toBe('INVALID_TRANSITION');

      const worker = await verifiedWorkerIn(t);
      const arrived = await postJob(t, customer);
      await t.prisma.job.update({
        where: { id: arrived.id },
        data: {
          status: 'ARRIVED',
          workerId: worker.userId,
          arrivedAt: new Date(),
          ...bookingWindow(),
        },
      });
      const late = await http
        .post(
          `${JOBS}/${arrived.id}/cancel`,
          {},
          { token: customer.accessToken },
        )
        .expect(409);
      expect(late.body.code).toBe('INVALID_TRANSITION');
    });

    it('cannot be done by anyone else', async () => {
      const customer = await customerIn(t);
      const other = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const job = await postJob(t, customer);
      await http
        .post(`${JOBS}/${job.id}/cancel`, {}, { token: other.accessToken })
        .expect(404);
      await http
        .post(`${JOBS}/${job.id}/cancel`, {}, { token: worker.accessToken })
        .expect(403);
      expect(
        (await t.prisma.job.findUniqueOrThrow({ where: { id: job.id } }))
          .status,
      ).toBe('OPEN');
    });

    it('rejects an over-long reason', async () => {
      const customer = await customerIn(t);
      const job = await postJob(t, customer);
      await http
        .post(
          `${JOBS}/${job.id}/cancel`,
          { reason: 'x'.repeat(301) },
          { token: customer.accessToken },
        )
        .expect(422);
    });
  });

  describe('expiry sweeper', () => {
    it('cancels overdue open jobs as SYSTEM/EXPIRED, rejects their quotes, and leaves everything else alone', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const overdue = await postJob(t, customer);
      const fresh = await postJob(t, customer);
      const assigned = await postJob(t, customer);
      await sendQuote(t, worker, overdue.id);

      const past = new Date(Date.now() - 60_000);
      await t.prisma.job.update({
        where: { id: overdue.id },
        data: { expiresAt: past },
      });
      await t.prisma.job.update({
        where: { id: assigned.id },
        data: {
          expiresAt: past,
          status: 'ASSIGNED',
          workerId: worker.userId,
          ...bookingWindow(),
        },
      });

      const expired = await t.app.get(JobExpiryService).expireOverdue();
      expect(expired).toBe(1);

      const rows = await t.prisma.job.findMany({
        where: { id: { in: [overdue.id, fresh.id, assigned.id] } },
      });
      const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
      expect(byId[overdue.id]).toMatchObject({
        status: 'CANCELLED',
        cancelledBy: 'SYSTEM',
        cancelReason: 'EXPIRED',
      });
      expect(byId[fresh.id]!.status).toBe('OPEN');
      expect(byId[assigned.id]!.status).toBe('ASSIGNED');
      expect(
        (
          await t.prisma.offer.findFirstOrThrow({
            where: { jobId: overdue.id },
          })
        ).status,
      ).toBe('REJECTED');

      expect(await t.app.get(JobExpiryService).expireOverdue()).toBe(0); // idempotent
    });

    it('survives two sweeps running at the same moment (exactly one wins each job)', async () => {
      const customer = await customerIn(t);
      const job = await postJob(t, customer);
      await t.prisma.job.update({
        where: { id: job.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      const sweeper = t.app.get(JobExpiryService);
      const results = await Promise.all([
        sweeper.expireOverdue(),
        sweeper.expireOverdue(),
        sweeper.expireOverdue(),
      ]);
      expect(results.reduce((a, b) => a + b, 0)).toBe(1);
    });
  });

  describe('worker profile is not enough to post, and unverified workers are never matched', () => {
    it('an unverified worker is not notified and cannot see leads', async () => {
      const customer = await customerIn(t);
      const pending = await verifiedWorkerIn(t, { verified: false });
      const job = await postJob(t, customer);
      expect(job.notifiedWorkers).toBe(0);
      const res = await http
        .get(`${V1}/leads`, { token: pending.accessToken })
        .expect(403);
      expect(res.body.code).toBe('NOT_VERIFIED');
    });
  });

  describe('sanity', () => {
    it('a user can be both: the same account posts jobs as a customer and sees leads as a worker', async () => {
      const dual = await customerIn(t);
      await http
        .put(
          `${V1}/workers/me`,
          workerPayload(dual.areaId, { trades: ['plumber'] }),
          { token: dual.accessToken },
        )
        .expect(200);
      await t.prisma.workerProfile.update({
        where: { userId: dual.userId },
        data: { verificationStatus: 'VERIFIED' },
      });
      const other = await customerIn(t);
      const otherJob = await postJob(t, other);
      await postJob(t, dual); // their own job must not appear in their own radar

      const leads = await http
        .get(`${V1}/leads`, { token: dual.accessToken })
        .expect(200);
      expect(leads.body.items.map((i: { id: string }) => i.id)).toEqual([
        otherJob.id,
      ]);
    });
  });
});
