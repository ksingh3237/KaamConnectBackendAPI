import { OTHER_AREA } from '../prisma/data/locations.js';
import { seedReferenceData } from '../prisma/seed/reference-data.js';
import { api, createTestApp, type TestApp } from './helpers/app.js';
import { resetDatabase } from './helpers/db.js';
import { loginAs } from './helpers/auth.js';
import { nextPhone } from './helpers/factories.js';
import {
  areaId,
  customerIn,
  postJob,
  verifiedWorkerIn,
} from './helpers/marketplace.js';
import { customerPayload } from './helpers/personas.js';

const V1 = '/api/v1';

describe('worker "taking jobs" switch, worker address and typed localities (e2e)', () => {
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

  describe('taking jobs (isAvailable)', () => {
    it('is on by default, and the worker can switch it off and on', async () => {
      const worker = await verifiedWorkerIn(t);
      const me = await http
        .get(`${V1}/workers/me`, { token: worker.accessToken })
        .expect(200);
      expect(me.body.isAvailable).toBe(true);

      const off = await http
        .patch(
          `${V1}/workers/me`,
          { isAvailable: false },
          { token: worker.accessToken },
        )
        .expect(200);
      expect(off.body.isAvailable).toBe(false);
      // switching availability is not a profile change: verification stays as it was
      expect(off.body.verificationStatus).toBe('VERIFIED');

      const on = await http
        .patch(
          `${V1}/workers/me`,
          { isAvailable: true },
          { token: worker.accessToken },
        )
        .expect(200);
      expect(on.body.isAvailable).toBe(true);
    });

    it('a switched-off worker is not notified of new jobs, is not listed, and cannot be booked directly', async () => {
      const customer = await customerIn(t);
      await verifiedWorkerIn(t, { fullName: 'On Worker' }); // taking jobs: the only one notified
      const off = await verifiedWorkerIn(t, { fullName: 'Off Worker' });
      await http
        .patch(
          `${V1}/workers/me`,
          { isAvailable: false },
          { token: off.accessToken },
        )
        .expect(200);

      const job = await postJob(t, customer);
      expect(job.notifiedWorkers).toBe(1); // only the one taking jobs

      const listed = await http
        .get(`${V1}/workers?categoryId=plumber`, {
          token: customer.accessToken,
        })
        .expect(200);
      const names = (listed.body.items as { name: string }[]).map(
        (w) => w.name,
      );
      expect(names).toContain('On Worker');
      expect(names).not.toContain('Off Worker');

      const refused = await http
        .post(
          `${V1}/jobs/direct-booking`,
          {
            categoryId: 'plumber',
            title: 'Geyser not working',
            timing: 'IMMEDIATE',
            addressId: customer.addressId,
            workerId: off.userId,
          },
          { token: customer.accessToken },
        )
        .expect(409);
      expect(refused.body.code).toBe('WORKER_OFFLINE');

      // back on: bookable again
      await http
        .patch(
          `${V1}/workers/me`,
          { isAvailable: true },
          { token: off.accessToken },
        )
        .expect(200);
      await http
        .post(
          `${V1}/jobs/direct-booking`,
          {
            categoryId: 'plumber',
            title: 'Geyser not working',
            timing: 'IMMEDIATE',
            addressId: customer.addressId,
            workerId: off.userId,
          },
          { token: customer.accessToken },
        )
        .expect(201);
    });

    it('a switched-off worker can still see the lead feed (they chose to look)', async () => {
      const customer = await customerIn(t);
      const off = await verifiedWorkerIn(t);
      await http
        .patch(
          `${V1}/workers/me`,
          { isAvailable: false },
          { token: off.accessToken },
        )
        .expect(200);
      const job = await postJob(t, customer);
      const feed = await http
        .get(`${V1}/leads`, { token: off.accessToken })
        .expect(200);
      expect((feed.body.items as { id: string }[]).map((l) => l.id)).toContain(
        job.id,
      );
    });
  });

  describe('worker address and locality', () => {
    it('stores the shop address and a typed locality, and shows the locality on the public card', async () => {
      const worker = await verifiedWorkerIn(t);
      const other = await areaId(t, OTHER_AREA, 'Mohali (SAS Nagar)');
      const res = await http
        .patch(
          `${V1}/workers/me`,
          {
            addressLine: 'Shop 4, Main Market',
            localityName: 'Sector 82 JLPL',
            baseAreaId: other,
          },
          { token: worker.accessToken },
        )
        .expect(200);
      expect(res.body).toMatchObject({
        addressLine: 'Shop 4, Main Market',
        locality: 'Sector 82 JLPL',
        baseArea: { id: other, name: OTHER_AREA },
        city: { name: 'Mohali (SAS Nagar)' },
      });

      const customer = await customerIn(t, 'Phase 7', 'Mohali (SAS Nagar)');
      const card = await http
        .get(`${V1}/workers/${worker.userId}`, { token: customer.accessToken })
        .expect(200);
      expect(card.body.areaName).toBe('Sector 82 JLPL');
      // the shop address is private
      expect(JSON.stringify(card.body)).not.toContain('Main Market');
    });

    it('rejects a too-long address or locality, and null clears them', async () => {
      const worker = await verifiedWorkerIn(t);
      await http
        .patch(
          `${V1}/workers/me`,
          { addressLine: 'x'.repeat(201) },
          { token: worker.accessToken },
        )
        .expect(422);
      await http
        .patch(
          `${V1}/workers/me`,
          { localityName: 'y'.repeat(81) },
          { token: worker.accessToken },
        )
        .expect(422);
      await http
        .patch(
          `${V1}/workers/me`,
          { addressLine: 'Shop 4', localityName: 'Dhanas' },
          { token: worker.accessToken },
        )
        .expect(200);
      const cleared = await http
        .patch(
          `${V1}/workers/me`,
          { addressLine: null, localityName: null },
          { token: worker.accessToken },
        )
        .expect(200);
      expect(cleared.body).toMatchObject({ addressLine: null, locality: null });
    });
  });

  describe('customer typed locality', () => {
    it('is saved on the address, copied onto the job, and shown to workers instead of "Other area"', async () => {
      const me = await loginAs(t, nextPhone());
      const other = await areaId(t, OTHER_AREA, 'Chandigarh');
      const saved = await http
        .put(
          `${V1}/customers/me`,
          customerPayload(other, {
            address: {
              areaId: other,
              line: 'House 9, near Gurudwara',
              localityName: 'Dhanas Colony',
            },
          }),
          { token: me.accessToken },
        )
        .expect(200);
      const address = saved.body.addresses[0];
      expect(address).toMatchObject({
        area: { id: other, name: OTHER_AREA },
        locality: 'Dhanas Colony',
      });

      const worker = await verifiedWorkerIn(t); // Chandigarh plumber
      const job = await http
        .post(
          `${V1}/jobs`,
          {
            categoryId: 'plumber',
            title: 'Tap leaking',
            timing: 'IMMEDIATE',
            addressId: address.id,
          },
          { token: me.accessToken },
        )
        .expect(201);
      expect(job.body.notifiedWorkers).toBe(1); // same city: matched

      const feed = await http
        .get(`${V1}/leads`, { token: worker.accessToken })
        .expect(200);
      const lead = (feed.body.items as { id: string; areaName: string }[]).find(
        (l) => l.id === job.body.id,
      );
      expect(lead?.areaName).toBe('Dhanas Colony');

      const view = await http
        .get(`${V1}/jobs/${job.body.id}`, { token: me.accessToken })
        .expect(200);
      expect(view.body.locality).toBe('Dhanas Colony');
    });
  });
});
