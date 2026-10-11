// DELETE /me: account deletion by anonymisation (docs/08 section 1). Door A (the person, with a fresh code) and
// Door B (a disabled person asks, an admin decides), row by row against the database.

import request from 'supertest';
import { seedReferenceData } from '../prisma/seed/reference-data.js';
import { DeletionLedger } from '../src/modules/account/deletion-ledger.js';
import { AccountDeletionService } from '../src/modules/account/account-deletion.service.js';
import { StorageService } from '../src/modules/media/storage/storage.service.js';
import { RealtimePublisher } from '../src/modules/realtime/realtime-publisher.js';
import { api, createTestApp, freshIp, type TestApp } from './helpers/app.js';
import { expireCooldown, loginAs } from './helpers/auth.js';
import { resetDatabase } from './helpers/db.js';
import { nextPhone } from './helpers/factories.js';
import {
  V1,
  assigned,
  finished,
  onSite,
  payFor,
  underWay,
} from './helpers/fulfilment.js';
import {
  customerIn,
  postJob,
  sendQuote,
  verifiedWorkerIn,
  type Customer,
  type Worker,
} from './helpers/marketplace.js';
import { uploadFile } from './helpers/personas.js';
import { acceptQuote } from './helpers/scheduling.js';

describe('account deletion by anonymisation (e2e)', () => {
  let t: TestApp;
  let http: ReturnType<typeof api>;
  let ledger: DeletionLedger;
  let storage: StorageService;

  beforeAll(async () => {
    t = await createTestApp();
    http = api(t.app);
    ledger = t.app.get(DeletionLedger);
    storage = t.app.get(StorageService);
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    await seedReferenceData(t.prisma);
    t.safety.sent = [];
    t.safety.fail = false;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Asks for a fresh code for this number, the way the app does, and returns it. */
  const freshCode = async (phone: string): Promise<string> => {
    await expireCooldown(t.prisma, phone);
    await http.post(`${V1}/auth/otp/request`, { phone }).expect(202);
    return t.sender.lastCode(phone);
  };

  /** DELETE /me with a body (the shared helper sends none). */
  const deleteMe = (token: string, body: Record<string, unknown>) =>
    request(t.app.getHttpServer())
      .delete(`${V1}/me`)
      .set('X-Forwarded-For', freshIp())
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  const deleteWithCode = (who: { phone: string; accessToken: string }) => ({
    /** Same call shape as supertest: `await deleteWithCode(x).expect(204)`. */
    expect: async (status: number) => {
      const res = await deleteMe(who.accessToken, {
        code: await freshCode(who.phone),
        confirm: true,
      });
      expect(res.status, JSON.stringify(res.body)).toBe(status);
      return res;
    },
  });

  const makeAdmin = async () => {
    const admin = await loginAs(t, nextPhone());
    await t.prisma.user.update({
      where: { id: admin.userId },
      data: { isAdmin: true },
    });
    return admin;
  };

  const userRow = (id: string) =>
    t.prisma.user.findUniqueOrThrow({ where: { id } });

  describe('Door A: the person, with a fresh code', () => {
    it('refuses without both the confirmation and a code, and changes nothing', async () => {
      const me = await customerIn(t);
      const code = await freshCode(me.phone);

      await deleteMe(me.accessToken, {}).expect(422);
      await deleteMe(me.accessToken, { code }).expect(422); // no confirm
      await deleteMe(me.accessToken, { code, confirm: false }).expect(422);
      await deleteMe(me.accessToken, { code: '12345', confirm: true }).expect(
        422,
      );
      await http.delete(`${V1}/me`).expect(401); // not signed in

      const row = await userRow(me.userId);
      expect(row.isActive).toBe(true);
      expect(row.deletedAt).toBeNull();
      expect(row.phone).toBe(me.phone);
    });

    it('a stolen session alone is not enough: a wrong, missing or reused code is refused and counted', async () => {
      const me = await customerIn(t);

      // no code was ever requested
      await deleteMe(me.accessToken, { code: '123456', confirm: true }).expect(
        401,
      );

      // a wrong code
      const code = await freshCode(me.phone);
      const wrong = code === '000000' ? '111111' : '000000';
      const bad = await deleteMe(me.accessToken, {
        code: wrong,
        confirm: true,
      }).expect(401);
      expect(bad.body.code).toBe('OTP_INVALID');
      const challenge = await t.prisma.otpChallenge.findFirstOrThrow({
        where: { phone: me.phone },
        orderBy: { createdAt: 'desc' },
      });
      expect(challenge.attempts).toBe(1); // the wrong guess was counted

      expect((await userRow(me.userId)).deletedAt).toBeNull();

      // the right code works once...
      await deleteMe(me.accessToken, { code, confirm: true }).expect(204);
      // ...and a replay is useless (the account is gone, the code is spent)
      await deleteMe(me.accessToken, { code, confirm: true }).expect(403);
    });

    it("anonymises a customer row by row, keeps the other person's history, and frees the number", async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const photo = await uploadFile(t, customer.accessToken, 'PROFILE_PHOTO');
      await t.prisma.customerProfile.update({
        where: { userId: customer.userId },
        data: { photoKey: photo.key },
      });
      const problemPhoto = await uploadFile(
        t,
        customer.accessToken,
        'JOB_PHOTO',
      );
      const done = await finished(t, customer, worker);
      await payFor(t, customer, done.job.id).expect(200);
      await t.prisma.jobMedia.create({
        data: {
          jobId: done.job.id,
          kind: 'PROBLEM_PHOTO',
          storageKey: problemPhoto.key,
        },
      });
      await t.prisma.job.update({
        where: { id: done.job.id },
        data: { lat: 30.7, lng: 76.7 },
      });
      const spy = vi.spyOn(ledger, 'append');
      const disconnect = vi.spyOn(
        t.app.get(RealtimePublisher),
        'disconnectUser',
      );
      const oldPhone = customer.phone;

      await deleteWithCode(customer).expect(204);

      // the account
      const user = await userRow(customer.userId);
      expect(user.phone).toMatch(/^del[0-9a-f]{12}$/);
      expect(user.phone).not.toBe(oldPhone);
      expect(user.isActive).toBe(false);
      expect(user.isAdmin).toBe(false);
      expect(user.deletedAt).not.toBeNull();
      expect(
        await t.prisma.refreshToken.count({
          where: { userId: customer.userId },
        }),
      ).toBe(0);
      expect(
        await t.prisma.otpChallenge.count({ where: { phone: oldPhone } }),
      ).toBe(0);

      // the profile and address
      const profile = await t.prisma.customerProfile.findUniqueOrThrow({
        where: { userId: customer.userId },
      });
      expect(profile.fullName).toBe('Deleted user');
      expect(profile.photoKey).toBeNull();
      expect(
        await t.prisma.address.count({
          where: { customerId: customer.userId },
        }),
      ).toBe(0);

      // the job is kept, the home is not
      const job = await t.prisma.job.findUniqueOrThrow({
        where: { id: done.job.id },
      });
      expect(job.status).toBe('COMPLETED');
      expect(job.addressLine).toBe('(removed)');
      expect(job.lat).toBeNull();
      expect(job.lng).toBeNull();
      expect(job.description).toBeNull();
      expect(job.arrivalCode).toBeNull();
      expect(job.title).toBeTruthy(); // kept (docs/08 s1.9 item 2)
      expect(
        await t.prisma.jobMedia.count({ where: { jobId: done.job.id } }),
      ).toBe(0);
      expect(
        await t.prisma.payment.count({ where: { jobId: done.job.id } }),
      ).toBe(1); // accounting record kept
      expect(
        await t.prisma.billItem.count({ where: { jobId: done.job.id } }),
      ).toBeGreaterThan(0);

      // the files are gone
      expect(await storage.exists('media', photo.key)).toBe(false);
      expect(await storage.exists('media', problemPhoto.key)).toBe(false);

      // the worker still has the job and receipt, with the customer shown as deleted
      const receipt = await http
        .get(`${V1}/jobs/${done.job.id}/receipt`, { token: worker.accessToken })
        .expect(200);
      expect(receipt.body.customer.name).toBe('Deleted user');
      expect(receipt.body.total).toBe(done.total);

      // after-commit effects
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({ userId: customer.userId, actor: 'SELF' }),
      );
      expect(disconnect).toHaveBeenCalledWith(customer.userId);

      // nothing that identifies the person survives anywhere
      const everything = JSON.stringify({
        user,
        profile,
        job,
        receipt: receipt.body,
      });
      expect(everything).not.toContain(oldPhone);
      expect(everything).not.toContain('Sunita');
      expect(everything).not.toContain('House #1402');
    });

    it('the old session stops working, and the same number signs up again as a brand-new account', async () => {
      const me = await customerIn(t);
      await deleteWithCode(me).expect(204);

      // the 15-minute access token is refused at once; the refresh token is gone
      const refused = await http
        .get(`${V1}/me`, { token: me.accessToken })
        .expect(403);
      expect(refused.body.code).toBe('ACCOUNT_DISABLED');
      await http
        .post(`${V1}/auth/refresh`, { refreshToken: me.refreshToken })
        .expect(401);

      const again = await loginAs(t, me.phone);
      expect(again.isNewUser).toBe(true);
      expect(again.userId).not.toBe(me.userId);
      const fresh = await http
        .get(`${V1}/me`, { token: again.accessToken })
        .expect(200);
      expect(fresh.body.customer).toBeNull(); // nothing carried over
    });

    it("removes a worker's payment details, documents, files and visibility, and withdraws their quotes", async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const photo = await uploadFile(t, worker.accessToken, 'PROFILE_PHOTO');
      const front = await uploadFile(t, worker.accessToken, 'AADHAAR');
      await t.prisma.workerProfile.update({
        where: { userId: worker.userId },
        data: {
          photoKey: photo.key,
          upiId: 'raj@upi',
          vehicle: 'Splendor',
          badge: 'Pro',
        },
      });
      await t.prisma.workerDocument.create({
        data: {
          workerId: worker.userId,
          type: 'AADHAAR_FRONT',
          storageKey: front.key,
        },
      });
      const open = await postJob(t, customer);
      const quote = await sendQuote(t, worker, open.id, {
        message: 'call me on 98xxx',
      });
      expect(quote.id).toBeTruthy();

      await deleteWithCode(worker).expect(204);

      const profile = await t.prisma.workerProfile.findUniqueOrThrow({
        where: { userId: worker.userId },
      });
      expect(profile).toMatchObject({
        fullName: 'Deleted worker',
        photoKey: null,
        upiId: null,
        vehicle: null,
        badge: null,
        rejectionReason: null,
        skills: [],
        languages: [],
        visitingFee: null,
        verificationStatus: 'REJECTED',
      });
      expect(
        await t.prisma.workerDocument.count({
          where: { workerId: worker.userId },
        }),
      ).toBe(0);
      expect(
        await t.prisma.workerLocation.count({
          where: { workerId: worker.userId },
        }),
      ).toBe(0);
      expect(
        await t.prisma.workerTrade.count({
          where: { workerId: worker.userId },
        }),
      ).toBe(0);
      expect(await storage.exists('media', photo.key)).toBe(false);
      expect(await storage.exists('private', front.key)).toBe(false);

      const offer = await t.prisma.offer.findFirstOrThrow({
        where: { workerId: worker.userId },
      });
      expect(offer.status).toBe('WITHDRAWN');
      expect(offer.message).toBeNull();

      // nobody can find or hire them
      const found = await http
        .get(`${V1}/workers?categoryId=plumber`, {
          token: customer.accessToken,
        })
        .expect(200);
      expect(found.body.items.map((w: { id: string }) => w.id)).not.toContain(
        worker.userId,
      );
      const quotes = await http
        .get(`${V1}/jobs/${open.id}/offers`, { token: customer.accessToken })
        .expect(200);
      expect(quotes.body).toEqual([]);
    });

    it('declines "Book Pro" requests addressed to the worker and tells the customer', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const booked = await http
        .post(
          `${V1}/jobs/direct-booking`,
          {
            categoryId: 'plumber',
            title: 'Leaking tap',
            timing: 'IMMEDIATE',
            addressId: customer.addressId,
            workerId: worker.userId,
          },
          { token: customer.accessToken },
        )
        .expect(201);

      await deleteWithCode(worker).expect(204);

      const job = await t.prisma.job.findUniqueOrThrow({
        where: { id: booked.body.id },
      });
      expect(job).toMatchObject({
        status: 'CANCELLED',
        cancelledBy: 'WORKER',
        cancelReason: 'DECLINED',
      });
    });

    describe('is refused while a job is active (nothing changes)', () => {
      const expectBlocked = async (who: Customer | Worker, jobId: string) => {
        const res = await deleteWithCode(who).expect(409);
        expect(res.body.code).toBe('ACTIVE_JOB_BLOCKS_DELETION');
        expect(JSON.stringify(res.body.details)).toContain(`job:${jobId}`);
        const row = await userRow(who.userId);
        expect(row.isActive).toBe(true);
        expect(row.deletedAt).toBeNull();
        expect(row.phone).toBe(who.phone);
      };

      it('OPEN (customer)', async () => {
        const customer = await customerIn(t);
        const job = await postJob(t, customer);
        await expectBlocked(customer, job.id);
      });

      it('ASSIGNED (both sides)', async () => {
        const customer = await customerIn(t);
        const worker = await verifiedWorkerIn(t);
        const { job } = await assigned(t, customer, worker);
        await expectBlocked(customer, job.id);
        await expectBlocked(worker, job.id);
      });

      it('ARRIVED (both sides)', async () => {
        const customer = await customerIn(t);
        const worker = await verifiedWorkerIn(t);
        const { job } = await onSite(t, customer, worker);
        await expectBlocked(customer, job.id);
        await expectBlocked(worker, job.id);
      });

      it('IN_PROGRESS (both sides)', async () => {
        const customer = await customerIn(t);
        const worker = await verifiedWorkerIn(t);
        const { job } = await underWay(t, customer, worker);
        await expectBlocked(customer, job.id);
        await expectBlocked(worker, job.id);
      });

      it('WORK_COMPLETED, payment still to record (both sides)', async () => {
        const customer = await customerIn(t);
        const worker = await verifiedWorkerIn(t);
        const { job } = await finished(t, customer, worker);
        await expectBlocked(customer, job.id);
        await expectBlocked(worker, job.id);
      });

      it('an SOS alert of their own that is still open', async () => {
        const customer = await customerIn(t);
        const worker = await verifiedWorkerIn(t);
        const { job } = await assigned(t, customer, worker);
        await http
          .post(`${V1}/jobs/${job.id}/sos`, {}, { token: customer.accessToken })
          .expect(201);
        // finish the job so only the alert is left
        await t.prisma.job.update({
          where: { id: job.id },
          data: {
            status: 'CANCELLED',
            cancelledAt: new Date(),
            cancelledBy: 'SYSTEM',
          },
        });
        const res = await deleteWithCode(customer).expect(409);
        expect(JSON.stringify(res.body.details)).toContain('sos');
      });

      it('COMPLETED and CANCELLED never block', async () => {
        const customer = await customerIn(t);
        const worker = await verifiedWorkerIn(t);
        const done = await finished(t, customer, worker);
        await payFor(t, customer, done.job.id).expect(200);
        const cancelled = await postJob(t, customer);
        await http
          .post(
            `${V1}/jobs/${cancelled.id}/cancel`,
            {},
            { token: customer.accessToken },
          )
          .expect(200);

        await deleteWithCode(customer).expect(204);
        await deleteWithCode(worker).expect(204);
      });
    });

    it('refuses an admin account', async () => {
      const admin = await makeAdmin();
      const res = await deleteWithCode(admin).expect(409);
      expect(res.body.code).toBe('ADMIN_CANNOT_DELETE_SELF');
      expect((await userRow(admin.userId)).deletedAt).toBeNull();
    });

    it('refuses a disabled account and points to the request route', async () => {
      const me = await customerIn(t);
      await t.prisma.user.update({
        where: { id: me.userId },
        data: { isActive: false },
      });
      const res = await deleteMe(me.accessToken, {
        code: '123456',
        confirm: true,
      }).expect(403);
      expect(res.body.code).toBe('ACCOUNT_DISABLED');
    });

    it('if storage is down nothing changes and the same code can be used to try again', async () => {
      const me = await customerIn(t);
      const photo = await uploadFile(t, me.accessToken, 'PROFILE_PHOTO');
      await t.prisma.customerProfile.update({
        where: { userId: me.userId },
        data: { photoKey: photo.key },
      });
      const code = await freshCode(me.phone);
      vi.spyOn(storage, 'delete').mockRejectedValueOnce(
        new Error('bucket unreachable'),
      );

      const failed = await deleteMe(me.accessToken, {
        code,
        confirm: true,
      }).expect(502);
      expect(failed.body.code).toBe('STORAGE_UNAVAILABLE');
      const row = await userRow(me.userId);
      expect(row.deletedAt).toBeNull();
      expect(row.phone).toBe(me.phone);
      expect(row.isActive).toBe(true);
      expect(
        (
          await t.prisma.customerProfile.findUniqueOrThrow({
            where: { userId: me.userId },
          })
        ).photoKey,
      ).toBe(photo.key);

      // the code was not spent, so the retry finishes the job
      await deleteMe(me.accessToken, { code, confirm: true }).expect(204);
      expect((await userRow(me.userId)).deletedAt).not.toBeNull();
      expect(await storage.exists('media', photo.key)).toBe(false);
    });

    it('two simultaneous requests with the same code delete once, write one ledger entry, and never fail halfway', async () => {
      const me = await customerIn(t);
      const code = await freshCode(me.phone);
      const spy = vi.spyOn(ledger, 'append');

      const [a, b] = await Promise.all([
        deleteMe(me.accessToken, { code, confirm: true }),
        deleteMe(me.accessToken, { code, confirm: true }),
      ]);
      // The loser either finds the work already done (204, the operation is idempotent) or is refused
      // because the account is already gone; it is never a server error.
      for (const status of [a.status, b.status])
        expect([204, 401, 403]).toContain(status);
      expect([a.status, b.status]).toContain(204);
      expect(spy).toHaveBeenCalledTimes(1);
      expect((await userRow(me.userId)).deletedAt).not.toBeNull();
    });

    it('a quote accepted at the same moment can never strand a job on a deleted worker', async () => {
      for (let round = 0; round < 6; round += 1) {
        const customer = await customerIn(t);
        const worker = await verifiedWorkerIn(t);
        const job = await postJob(t, customer);
        const offer = await sendQuote(t, worker, job.id);
        const code = await freshCode(worker.phone);

        const [accept, remove] = await Promise.all([
          acceptQuote(t, customer, job.id, offer.id),
          deleteMe(worker.accessToken, { code, confirm: true }),
        ]);

        const after = await t.prisma.job.findUniqueOrThrow({
          where: { id: job.id },
        });
        const user = await userRow(worker.userId);
        if (user.deletedAt) {
          // deletion won: the job was never given to this worker
          expect(remove.status).toBe(204);
          expect(after.workerId).toBeNull();
          expect(after.status).toBe('OPEN');
          expect(accept.status).toBeGreaterThanOrEqual(400);
        } else {
          // acceptance won: the deletion was refused because the job is now active
          expect(accept.status).toBe(200);
          expect(after.workerId).toBe(worker.userId);
          expect(after.status).toBe('ASSIGNED');
          expect(remove.status).toBe(409);
        }
      }
    });
  });

  describe('Door B: a disabled person asks, an admin decides', () => {
    const disabledUser = async () => {
      const me = await customerIn(t);
      await t.prisma.user.update({
        where: { id: me.userId },
        data: { isActive: false },
      });
      return me;
    };
    const ask = async (phone: string, code?: string) =>
      http.post(`${V1}/auth/deletion-requests`, {
        phone,
        code: code ?? (await freshCode(phone)),
      });

    it('answers every number the same way and only records a request for a disabled account', async () => {
      const disabled = await disabledUser();
      const active = await customerIn(t);
      const admin = await makeAdmin();
      await t.prisma.user.update({
        where: { id: admin.userId },
        data: { isActive: false },
      });
      const unknown = nextPhone();

      const replies = [];
      for (const phone of [
        disabled.phone,
        active.phone,
        admin.phone,
        unknown,
      ]) {
        const res = await ask(phone).then((r) => r);
        replies.push({ status: res.status, body: res.body });
      }
      expect(new Set(replies.map((r) => JSON.stringify(r))).size).toBe(1);
      expect(replies[0]!.status).toBe(202);

      expect(
        (await userRow(disabled.userId)).deletionRequestedAt,
      ).not.toBeNull();
      expect((await userRow(active.userId)).deletionRequestedAt).toBeNull(); // active people use Door A
      expect((await userRow(admin.userId)).deletionRequestedAt).toBeNull(); // admins are never queued
      expect((await userRow(disabled.userId)).deletedAt).toBeNull(); // nothing is deleted by asking
    });

    it('needs a valid code: a wrong one records nothing', async () => {
      const disabled = await disabledUser();
      const code = await freshCode(disabled.phone);
      const wrong = code === '000000' ? '111111' : '000000';
      const res = await ask(disabled.phone, wrong).then((r) => r);
      expect(res.status).toBe(401);
      expect((await userRow(disabled.userId)).deletionRequestedAt).toBeNull();
    });

    it('is throttled per address', async () => {
      const ip = '203.0.113.77';
      let limited = 0;
      for (let i = 0; i < 7; i += 1) {
        const res = await http.post(
          `${V1}/auth/deletion-requests`,
          { phone: nextPhone(), code: '123456' },
          { ip },
        );
        if (res.status === 429) limited += 1;
      }
      expect(limited).toBeGreaterThan(0);
    });

    it('an admin lists the queue, approves (anonymising) or declines; others see nothing', async () => {
      const first = await disabledUser();
      const second = await disabledUser();
      const admin = await makeAdmin();
      await ask(first.phone);
      await ask(second.phone);

      // not for ordinary users, nor signed-out callers
      await http
        .get(`${V1}/admin/deletion-requests`, { token: second.accessToken })
        .expect(404);
      await http
        .post(
          `${V1}/admin/deletion-requests/${first.userId}/approve`,
          {},
          { token: second.accessToken },
        )
        .expect(404);
      await http.get(`${V1}/admin/deletion-requests`).expect(401);

      const list = await http
        .get(`${V1}/admin/deletion-requests`, { token: admin.accessToken })
        .expect(200);
      expect(
        list.body.items.map((i: { userId: string }) => i.userId).sort(),
      ).toEqual([first.userId, second.userId].sort());

      await http
        .post(
          `${V1}/admin/deletion-requests/${first.userId}/approve`,
          {},
          { token: admin.accessToken },
        )
        .expect(204);
      const gone = await userRow(first.userId);
      expect(gone.deletedAt).not.toBeNull();
      expect(gone.phone).toMatch(/^del[0-9a-f]{12}$/);

      await http
        .post(
          `${V1}/admin/deletion-requests/${second.userId}/decline`,
          {},
          { token: admin.accessToken },
        )
        .expect(204);
      const kept = await userRow(second.userId);
      expect(kept.deletedAt).toBeNull();
      expect(kept.deletionRequestedAt).toBeNull();

      // approving again is harmless; an unknown id is a 404
      await http
        .post(
          `${V1}/admin/deletion-requests/${first.userId}/approve`,
          {},
          { token: admin.accessToken },
        )
        .expect(204);
      await http
        .post(
          `${V1}/admin/deletion-requests/${second.userId}/approve`,
          {},
          { token: admin.accessToken },
        )
        .expect(404);
    });

    it('approval is refused while the person has an active job, and the request stays', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const admin = await makeAdmin();
      await assigned(t, customer, worker);
      await t.prisma.user.update({
        where: { id: worker.userId },
        data: { isActive: false },
      });
      await ask(worker.phone);

      const res = await http
        .post(
          `${V1}/admin/deletion-requests/${worker.userId}/approve`,
          {},
          { token: admin.accessToken },
        )
        .expect(409);
      expect(res.body.code).toBe('ACTIVE_JOB_BLOCKS_DELETION');
      const row = await userRow(worker.userId);
      expect(row.deletedAt).toBeNull();
      expect(row.deletionRequestedAt).not.toBeNull();
    });
  });

  describe('restoring a backup', () => {
    it('re-applies a ledger entry to an account that a restored backup brought back', async () => {
      const me = await customerIn(t);
      const service = t.app.get(AccountDeletionService);
      expect(await service.reapplyFromLedger(me.userId)).toBe('deleted');
      expect((await userRow(me.userId)).deletedAt).not.toBeNull();
      expect(await service.reapplyFromLedger(me.userId)).toBe('already'); // safe to run twice
    });
  });

  it('treats an object that is already gone as deleted, so a retry after a crash finishes the job', async () => {
    const me = await customerIn(t);
    const key = `u/${me.userId}/PROFILE_PHOTO/018f0000-0000-4000-8000-000000000002.jpg`;
    await t.prisma.customerProfile.update({
      where: { userId: me.userId },
      data: { photoKey: key },
    });
    expect(await storage.exists('media', key)).toBe(false); // never uploaded
    await deleteWithCode(me).expect(204);
    expect((await userRow(me.userId)).deletedAt).not.toBeNull();
  });
});
