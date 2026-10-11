// SOS delivery tracking, retry and acknowledgement. The alert row is always written first; delivery to the safety
// desk is remembered, retried with back-off, and a person at the desk acknowledges and resolves it.

import { seedReferenceData } from '../prisma/seed/reference-data.js';
import { Prisma } from '../src/generated/prisma/client.js';
import {
  SOS_MAX_DELIVERY_ATTEMPTS,
  SosDeliveryService,
  retryDelayMs,
} from '../src/modules/safety/sos-delivery.service.js';
import { api, createTestApp, type TestApp } from './helpers/app.js';
import { loginAs } from './helpers/auth.js';
import { resetDatabase } from './helpers/db.js';
import { nextPhone } from './helpers/factories.js';
import { V1, assigned } from './helpers/fulfilment.js';
import { customerIn, verifiedWorkerIn } from './helpers/marketplace.js';

describe('SOS delivery, retry and acknowledgement (e2e)', () => {
  let t: TestApp;
  let http: ReturnType<typeof api>;
  let delivery: SosDeliveryService;

  beforeAll(async () => {
    t = await createTestApp();
    http = api(t.app);
    delivery = t.app.get(SosDeliveryService);
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

  const makeAdmin = async () => {
    const admin = await loginAs(t, nextPhone());
    await t.prisma.user.update({
      where: { id: admin.userId },
      data: { isAdmin: true },
    });
    return admin;
  };

  const raise = (jobId: string, token: string) =>
    http.post(`${V1}/jobs/${jobId}/sos`, {}, { token });

  it('stores what the desk is told, records the delivery, and tells the person it arrived', async () => {
    const customer = await customerIn(t);
    const worker = await verifiedWorkerIn(t);
    const { job } = await assigned(t, customer, worker);

    const res = await raise(job.id, customer.accessToken).expect(201);
    expect(res.body).toMatchObject({
      status: 'OPEN',
      delivered: true,
      repeated: false,
      acknowledgedAt: null,
      resolvedAt: null,
    });

    const row = await t.prisma.sosAlert.findUniqueOrThrow({
      where: { id: res.body.alertId },
    });
    expect(row.deliveredAt).not.toBeNull();
    expect(row.deliveryAttempts).toBe(1);
    expect(row.lastDeliveryError).toBeNull();
    // The stored payload is exactly what the desk received
    expect(row.payload).toEqual(JSON.parse(JSON.stringify(t.safety.sent[0])));
  });

  it('keeps an alert the desk did not receive, tells the person honestly, and retries after the back-off', async () => {
    const customer = await customerIn(t);
    const worker = await verifiedWorkerIn(t);
    const { job } = await assigned(t, customer, worker);

    t.safety.fail = true;
    const res = await raise(job.id, customer.accessToken).expect(201); // never fails the request
    expect(res.body).toMatchObject({ status: 'OPEN', delivered: false });

    let row = await t.prisma.sosAlert.findUniqueOrThrow({
      where: { id: res.body.alertId },
    });
    expect(row.deliveredAt).toBeNull();
    expect(row.deliveryAttempts).toBe(1);
    expect(row.lastDeliveryError).toContain('desk unreachable');
    expect(row.payload).not.toBeNull();

    // Too soon: the back-off has not passed, so the sweep leaves it alone
    expect(await delivery.retryUndelivered(new Date())).toBe(0);
    expect(row.deliveryAttempts).toBe(1);

    // Still down after the back-off: tried again, counted again
    const later = new Date(Date.now() + retryDelayMs(1) + 1000);
    expect(await delivery.retryUndelivered(later)).toBe(1);
    row = await t.prisma.sosAlert.findUniqueOrThrow({
      where: { id: res.body.alertId },
    });
    expect(row.deliveryAttempts).toBe(2);
    expect(row.deliveredAt).toBeNull();

    // The desk is back: the next due sweep delivers the same payload and clears the error
    t.safety.fail = false;
    const muchLater = new Date(Date.now() + retryDelayMs(2) + 120_000);
    expect(await delivery.retryUndelivered(muchLater)).toBe(1);
    row = await t.prisma.sosAlert.findUniqueOrThrow({
      where: { id: res.body.alertId },
    });
    expect(row.deliveredAt).not.toBeNull();
    expect(row.deliveryAttempts).toBe(3);
    expect(row.lastDeliveryError).toBeNull();
    expect(t.safety.sent).toHaveLength(1);
    expect(t.safety.sent[0]!.alertId).toBe(res.body.alertId);

    // Delivered alerts are never sent again
    expect(
      await delivery.retryUndelivered(new Date(Date.now() + 3_600_000)),
    ).toBe(0);
    expect(t.safety.sent).toHaveLength(1);
  });

  it('stops retrying after the limit but never deletes the alert', async () => {
    const customer = await customerIn(t);
    const worker = await verifiedWorkerIn(t);
    const { job } = await assigned(t, customer, worker);
    t.safety.fail = true;
    const res = await raise(job.id, customer.accessToken).expect(201);
    await t.prisma.sosAlert.update({
      where: { id: res.body.alertId },
      data: { deliveryAttempts: SOS_MAX_DELIVERY_ATTEMPTS },
    });

    t.safety.fail = false;
    expect(
      await delivery.retryUndelivered(new Date(Date.now() + 3_600_000)),
    ).toBe(0);
    const row = await t.prisma.sosAlert.findUniqueOrThrow({
      where: { id: res.body.alertId },
    });
    expect(row.deliveredAt).toBeNull();
    expect(row.status).toBe('OPEN'); // still on the admin list for a human
  });

  it('sends one attempt once even when two instances try at the same moment', async () => {
    const customer = await customerIn(t);
    const worker = await verifiedWorkerIn(t);
    const { job } = await assigned(t, customer, worker);
    t.safety.fail = true;
    const res = await raise(job.id, customer.accessToken).expect(201);
    t.safety.fail = false;

    const outcomes = await Promise.all([
      delivery.deliver(res.body.alertId),
      delivery.deliver(res.body.alertId),
      delivery.deliver(res.body.alertId),
    ]);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(t.safety.sent).toHaveLength(1);
  });

  it('skips alerts from before delivery tracking (no payload) instead of failing', async () => {
    const customer = await customerIn(t);
    const old = await t.prisma.sosAlert.create({
      data: { userId: customer.userId, payload: Prisma.DbNull },
    });
    expect(await delivery.deliver(old.id)).toBe(false);
    expect(await delivery.retryUndelivered(new Date())).toBe(0);
    expect(t.safety.sent).toHaveLength(0);
  });

  it('shows the person only their own alerts and where they stand, and refuses outsiders', async () => {
    const customer = await customerIn(t);
    const worker = await verifiedWorkerIn(t);
    const outsider = await customerIn(t);
    const { job } = await assigned(t, customer, worker);
    const res = await raise(job.id, customer.accessToken).expect(201);

    const mine = await http
      .get(`${V1}/jobs/${job.id}/sos`, { token: customer.accessToken })
      .expect(200);
    expect(mine.body).toHaveLength(1);
    expect(mine.body[0]).toMatchObject({
      alertId: res.body.alertId,
      status: 'OPEN',
      delivered: true,
    });

    // The other person on the job did not raise it, so it is not listed for them
    const theirs = await http
      .get(`${V1}/jobs/${job.id}/sos`, { token: worker.accessToken })
      .expect(200);
    expect(theirs.body).toEqual([]);

    // Someone not on the job gets the same 404 as for a job that does not exist
    await http
      .get(`${V1}/jobs/${job.id}/sos`, { token: outsider.accessToken })
      .expect(404);
  });

  describe('the safety desk (admin)', () => {
    it('lists alerts, acknowledges and resolves them, and tells the person who raised it', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const admin = await makeAdmin();
      const { job } = await assigned(t, customer, worker);
      const raised = await raise(job.id, customer.accessToken).expect(201);
      const id = raised.body.alertId as string;

      const list = await http
        .get(`${V1}/admin/sos?status=OPEN`, { token: admin.accessToken })
        .expect(200);
      expect(list.body.items).toHaveLength(1);
      expect(list.body.items[0]).toMatchObject({
        alertId: id,
        status: 'OPEN',
        jobReference: job.reference,
        raisedBy: { role: 'CUSTOMER', phone: customer.phone },
        delivery: { delivered: true, attempts: 1, lastError: null },
      });

      const ack = await http
        .post(
          `${V1}/admin/sos/${id}/acknowledge`,
          {},
          { token: admin.accessToken },
        )
        .expect(200);
      expect(ack.body).toMatchObject({
        status: 'ACKNOWLEDGED',
        acknowledgedBy: admin.userId,
      });
      const firstAckTime = ack.body.acknowledgedAt as string;

      // Repeating it changes nothing (and does not move the time)
      const again = await http
        .post(
          `${V1}/admin/sos/${id}/acknowledge`,
          {},
          { token: admin.accessToken },
        )
        .expect(200);
      expect(again.body.acknowledgedAt).toBe(firstAckTime);

      // The person sees it
      const seen = await http
        .get(`${V1}/jobs/${job.id}/sos`, { token: customer.accessToken })
        .expect(200);
      expect(seen.body[0]).toMatchObject({ status: 'ACKNOWLEDGED' });

      const resolved = await http
        .post(`${V1}/admin/sos/${id}/resolve`, {}, { token: admin.accessToken })
        .expect(200);
      expect(resolved.body).toMatchObject({
        status: 'RESOLVED',
        resolvedBy: admin.userId,
      });

      // Acknowledging something already resolved does not reopen it
      const late = await http
        .post(
          `${V1}/admin/sos/${id}/acknowledge`,
          {},
          { token: admin.accessToken },
        )
        .expect(200);
      expect(late.body.status).toBe('RESOLVED');
    });

    it('resolving straight from OPEN records who took it on', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const admin = await makeAdmin();
      const { job } = await assigned(t, customer, worker);
      const raised = await raise(job.id, worker.accessToken).expect(201);

      const res = await http
        .post(
          `${V1}/admin/sos/${raised.body.alertId}/resolve`,
          {},
          { token: admin.accessToken },
        )
        .expect(200);
      expect(res.body).toMatchObject({
        status: 'RESOLVED',
        acknowledgedBy: admin.userId,
        resolvedBy: admin.userId,
      });
      expect(res.body.acknowledgedAt).not.toBeNull();
    });

    it('stops pushing an alert once a human has taken it on', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const admin = await makeAdmin();
      const { job } = await assigned(t, customer, worker);
      t.safety.fail = true;
      const raised = await raise(job.id, customer.accessToken).expect(201);
      await http
        .post(
          `${V1}/admin/sos/${raised.body.alertId}/acknowledge`,
          {},
          { token: admin.accessToken },
        )
        .expect(200);

      t.safety.fail = false;
      expect(
        await delivery.retryUndelivered(new Date(Date.now() + 3_600_000)),
      ).toBe(0);
    });

    it('is invisible to everyone who is not an admin, and 404s an unknown alert', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const admin = await makeAdmin();
      const { job } = await assigned(t, customer, worker);
      const raised = await raise(job.id, customer.accessToken).expect(201);

      for (const token of [customer.accessToken, worker.accessToken]) {
        await http.get(`${V1}/admin/sos`, { token }).expect(404);
        await http
          .post(
            `${V1}/admin/sos/${raised.body.alertId}/acknowledge`,
            {},
            { token },
          )
          .expect(404);
        await http
          .post(`${V1}/admin/sos/${raised.body.alertId}/resolve`, {}, { token })
          .expect(404);
      }
      await http.get(`${V1}/admin/sos`).expect(401);

      await http
        .post(
          `${V1}/admin/sos/0197a0c0-0000-7000-8000-000000000000/acknowledge`,
          {},
          { token: admin.accessToken },
        )
        .expect(404);
      await http
        .get(`${V1}/admin/sos?status=NOPE`, { token: admin.accessToken })
        .expect(422);
    });
  });
});
