// Decision D-8 (+ Q-22): changing the NAME or the PHOTO of a VERIFIED worker sends the profile back to review,
// because customers recognise a worker by exactly those two things. In production (manual mode) the worker
// disappears from customers until an admin approves again; in development (auto mode) the existing
// auto-approval re-verifies at once. A job already assigned to the worker is never stranded.

import { seedReferenceData } from '../prisma/seed/reference-data.js';
import { api, createTestApp, type TestApp } from './helpers/app.js';
import { loginAs } from './helpers/auth.js';
import { resetDatabase } from './helpers/db.js';
import { nextPhone } from './helpers/factories.js';
import { V1, arriveAt, assigned } from './helpers/fulfilment.js';
import { customerIn, verifiedWorkerIn } from './helpers/marketplace.js';
import {
  onboardedWorker,
  uploadFile,
  workerPayload,
} from './helpers/personas.js';

const ME = `${V1}/workers/me`;

describe('D-8: a name or photo change on a VERIFIED worker re-opens review (MANUAL mode, production behaviour)', () => {
  let t: TestApp;
  let http: ReturnType<typeof api>;

  beforeAll(async () => {
    t = await createTestApp({ verificationMode: 'manual' });
    http = api(t.app);
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    await seedReferenceData(t.prisma);
  });

  const row = (userId: string) =>
    t.prisma.workerProfile.findUniqueOrThrow({ where: { userId } });
  const patch = (token: string, body: object) =>
    http.patch(ME, body, { token });
  /** A verified worker who has a profile photo (uploaded for real, then stored). */
  async function verifiedWithPhoto() {
    const worker = await verifiedWorkerIn(t, { fullName: 'Rajesh Kumar' });
    const { key } = await uploadFile(t, worker.accessToken, 'PROFILE_PHOTO');
    await t.prisma.workerProfile.update({
      where: { userId: worker.userId },
      data: { photoKey: key, verifiedAt: new Date('2026-01-01T00:00:00Z') },
    });
    return { worker, key };
  }
  const backForReview = {
    verificationStatus: 'PENDING',
    rejectionReason: null,
  };

  describe('the name', () => {
    it('a different name sends a VERIFIED worker back to PENDING, clears verifiedAt, and hides them from customers', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t, { fullName: 'Rajesh Kumar' });
      const listed = async () =>
        (
          await http
            .get(`${V1}/workers`, { token: customer.accessToken })
            .expect(200)
        ).body.items.some((w: { id: string }) => w.id === worker.userId);
      expect(await listed()).toBe(true);

      const res = await patch(worker.accessToken, {
        fullName: 'Rakesh Kumar',
      }).expect(200);
      expect(res.body).toMatchObject({
        fullName: 'Rakesh Kumar',
        ...backForReview,
      });
      expect((await row(worker.userId)).verifiedAt).toBeNull();

      // Hidden from customers and from the lead feed until an admin approves again.
      expect(await listed()).toBe(false);
      await http
        .get(`${V1}/workers/${worker.userId}`, { token: customer.accessToken })
        .expect(404);
      const feed = await http
        .get(`${V1}/leads`, { token: worker.accessToken })
        .expect(403);
      expect(feed.body.code).toBe('NOT_VERIFIED');
    });

    it('works the same through PUT /workers/me (the onboarding save)', async () => {
      const worker = await verifiedWorkerIn(t, { fullName: 'Rajesh Kumar' });
      const res = await http
        .put(
          ME,
          workerPayload(worker.baseAreaId, {
            trades: ['plumber'],
            fullName: 'Rajesh Sharma',
          }),
          { token: worker.accessToken },
        )
        .expect(200);
      expect(res.body).toMatchObject(backForReview);
    });

    it('re-sending the same name, in another case or with extra spaces, changes nothing', async () => {
      const worker = await verifiedWorkerIn(t, { fullName: 'Rajesh Kumar' });
      const before = await row(worker.userId);
      for (const fullName of [
        'Rajesh Kumar',
        'rajesh kumar',
        '  RAJESH    kumar ',
      ]) {
        const res = await patch(worker.accessToken, { fullName }).expect(200);
        expect(res.body.verificationStatus).toBe('VERIFIED');
      }
      // PUT re-sending everything, as the onboarding screen does on every Save
      await http
        .put(
          ME,
          workerPayload(worker.baseAreaId, {
            trades: ['plumber'],
            fullName: 'RAJESH KUMAR',
          }),
          { token: worker.accessToken },
        )
        .expect(200)
        .expect((r) => expect(r.body.verificationStatus).toBe('VERIFIED'));
      expect((await row(worker.userId)).verifiedAt).toEqual(before.verifiedAt);
    });

    it('changing anything else (radius, skills, fee, languages) leaves them VERIFIED', async () => {
      const worker = await verifiedWorkerIn(t);
      const res = await patch(worker.accessToken, {
        radiusKm: 12,
        skills: ['Geyser repair'],
        visitingFee: 300,
        languages: ['hi'],
      }).expect(200);
      expect(res.body.verificationStatus).toBe('VERIFIED');
    });

    it('a worker who is already PENDING stays PENDING (and a rejected one is re-opened, as before)', async () => {
      const worker = await verifiedWorkerIn(t, { verified: false });
      expect(
        (await patch(worker.accessToken, { fullName: 'New Name' }).expect(200))
          .body.verificationStatus,
      ).toBe('PENDING');

      await t.prisma.workerProfile.update({
        where: { userId: worker.userId },
        data: { verificationStatus: 'REJECTED', rejectionReason: 'Blurry' },
      });
      const res = await patch(worker.accessToken, {
        experienceYears: 9,
      }).expect(200);
      expect(res.body).toMatchObject(backForReview);
    });
  });

  describe('the photo (Q-22)', () => {
    it('a different photo sends a VERIFIED worker back to PENDING', async () => {
      const { worker } = await verifiedWithPhoto();
      const { key: another } = await uploadFile(
        t,
        worker.accessToken,
        'PROFILE_PHOTO',
      );
      const res = await patch(worker.accessToken, {
        photoKey: another,
      }).expect(200);
      expect(res.body).toMatchObject(backForReview);
      expect((await row(worker.userId)).verifiedAt).toBeNull();
    });

    it('adding a first photo to a profile that had none counts as a different photo', async () => {
      const worker = await verifiedWorkerIn(t);
      const { key } = await uploadFile(t, worker.accessToken, 'PROFILE_PHOTO');
      const res = await patch(worker.accessToken, { photoKey: key }).expect(
        200,
      );
      expect(res.body).toMatchObject(backForReview);
    });

    it('re-sending the same photo changes nothing', async () => {
      const { worker, key } = await verifiedWithPhoto();
      const res = await patch(worker.accessToken, { photoKey: key }).expect(
        200,
      );
      expect(res.body.verificationStatus).toBe('VERIFIED');
      expect((await row(worker.userId)).verifiedAt).not.toBeNull();
    });

    it('removing the photo does not trigger a review (there is no face left to impersonate)', async () => {
      const { worker } = await verifiedWithPhoto();
      const res = await patch(worker.accessToken, { photoKey: null }).expect(
        200,
      );
      expect(res.body.verificationStatus).toBe('VERIFIED');
      expect((await row(worker.userId)).photoKey).toBeNull();
    });

    it("a photo that is not this worker's own upload is still refused, and nothing changes", async () => {
      const { worker } = await verifiedWithPhoto();
      const other = await verifiedWorkerIn(t);
      const { key } = await uploadFile(t, other.accessToken, 'PROFILE_PHOTO');
      await patch(worker.accessToken, { photoKey: key }).expect(422);
      expect((await row(worker.userId)).verificationStatus).toBe('VERIFIED');
    });
  });

  describe('what a re-review must never do', () => {
    it('does not strand a customer: a worker under review can still arrive at, and work, a job already assigned to them', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t, { fullName: 'Rajesh Kumar' });
      const { job, code } = await assigned(t, customer, worker);

      await patch(worker.accessToken, { fullName: 'Rakesh Kumar' }).expect(200);
      expect((await row(worker.userId)).verificationStatus).toBe('PENDING');

      const arrived = await arriveAt(t, worker, job.id, code).expect(200);
      expect(arrived.body.status).toBe('ARRIVED');
    });

    it('is undone by an admin approving again, after which the worker is visible once more', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t, { fullName: 'Rajesh Kumar' });
      await patch(worker.accessToken, { fullName: 'Rakesh Kumar' }).expect(200);
      // An approval needs both Aadhaar images on file.
      await t.prisma.workerDocument.createMany({
        data: [
          { workerId: worker.userId, type: 'AADHAAR_FRONT', storageKey: 'k1' },
          { workerId: worker.userId, type: 'AADHAAR_BACK', storageKey: 'k2' },
        ],
      });

      const admin = await loginAs(t, nextPhone());
      await t.prisma.user.update({
        where: { id: admin.userId },
        data: { isAdmin: true },
      });
      await http
        .post(
          `${V1}/admin/workers/${worker.userId}/verify`,
          {},
          { token: admin.accessToken },
        )
        .expect(200);

      expect((await row(worker.userId)).verificationStatus).toBe('VERIFIED');
      await http
        .get(`${V1}/workers/${worker.userId}`, { token: customer.accessToken })
        .expect(200);
    });

    it('several simultaneous saves with a new name leave exactly one consistent state: PENDING, never half-updated', async () => {
      const worker = await verifiedWorkerIn(t, { fullName: 'Rajesh Kumar' });
      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          patch(worker.accessToken, { fullName: 'Rakesh Kumar' }),
        ),
      );
      expect(results.map((r) => r.status)).toEqual(Array(6).fill(200));
      const final = await row(worker.userId);
      expect(final).toMatchObject({
        verificationStatus: 'PENDING',
        fullName: 'Rakesh Kumar',
        verifiedAt: null,
      });
    });
  });
});

describe('D-8 in AUTO mode (development shortcut): the existing auto-approval re-verifies at once', () => {
  let t: TestApp;
  let http: ReturnType<typeof api>;

  beforeAll(async () => {
    t = await createTestApp({ verificationMode: 'auto' });
    http = api(t.app);
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    await seedReferenceData(t.prisma);
  });

  it('with both Aadhaar images on file, a name change goes to PENDING and straight back to VERIFIED, with a fresh verifiedAt', async () => {
    const worker = await onboardedWorker(t, { fullName: 'Rajesh Kumar' });
    const first = await t.prisma.workerProfile.findUniqueOrThrow({
      where: { userId: worker.userId },
    });
    expect(first.verificationStatus).toBe('VERIFIED');
    await new Promise((resolve) => setTimeout(resolve, 20));

    const res = await http
      .patch(ME, { fullName: 'Rakesh Kumar' }, { token: worker.accessToken })
      .expect(200);
    expect(res.body).toMatchObject({
      fullName: 'Rakesh Kumar',
      verificationStatus: 'VERIFIED',
    });
    const after = await t.prisma.workerProfile.findUniqueOrThrow({
      where: { userId: worker.userId },
    });
    expect(after.verifiedAt!.getTime()).toBeGreaterThan(
      first.verifiedAt!.getTime(),
    );
  });

  it('without the images, the name change leaves them PENDING (auto mode only approves when both exist)', async () => {
    const worker = await onboardedWorker(t, { fullName: 'Rajesh Kumar' });
    await t.prisma.workerDocument.deleteMany({
      where: { workerId: worker.userId },
    });
    const res = await http
      .patch(ME, { fullName: 'Rakesh Kumar' }, { token: worker.accessToken })
      .expect(200);
    expect(res.body.verificationStatus).toBe('PENDING');
  });

  it('an unchanged name keeps the original verifiedAt (no needless re-approval)', async () => {
    const worker = await onboardedWorker(t, { fullName: 'Rajesh Kumar' });
    const first = await t.prisma.workerProfile.findUniqueOrThrow({
      where: { userId: worker.userId },
    });
    await http
      .patch(ME, { fullName: 'rajesh kumar' }, { token: worker.accessToken })
      .expect(200);
    const after = await t.prisma.workerProfile.findUniqueOrThrow({
      where: { userId: worker.userId },
    });
    expect(after.verifiedAt).toEqual(first.verifiedAt);
  });
});
