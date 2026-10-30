import { api, type TestApp } from './app.js';
import { loginAs } from './auth.js';
import { nextPhone } from './factories.js';
import {
  areaId,
  customerIn,
  postJob,
  sendQuote,
  verifiedWorkerIn,
  type Customer,
  type Worker,
} from './marketplace.js';
import { customerPayload, uploadFile, workerPayload } from './personas.js';
import { acceptQuote, scheduledJob } from './scheduling.js';

export const V1 = '/api/v1';
export const VISIT_FEE = 250; // what sendQuote() asks for by default

/** The worker enters the customer's code. Returns the pending request so a test can expect 200, 422 or 429. */
export function arriveAt(
  t: TestApp,
  worker: Worker,
  jobId: string,
  code: string,
) {
  return api(t.app).post(
    `${V1}/jobs/${jobId}/arrival`,
    { code },
    { token: worker.accessToken },
  );
}

export function putItems(
  t: TestApp,
  worker: Worker,
  jobId: string,
  items: { kind: string; description: string; amount: number }[],
) {
  return api(t.app).put(
    `${V1}/jobs/${jobId}/bill-items`,
    { items },
    { token: worker.accessToken },
  );
}

export function approveBill(
  t: TestApp,
  customer: Customer,
  jobId: string,
  expectedTotal: number,
) {
  return api(t.app).post(
    `${V1}/jobs/${jobId}/bill/approve`,
    { expectedTotal },
    { token: customer.accessToken },
  );
}

/** The worker uploads one work photo of `kind` and adds it to the job, the way the app does. */
export async function addProofPhoto(
  t: TestApp,
  worker: Worker,
  jobId: string,
  kind: 'BEFORE' | 'AFTER',
) {
  const { key } = await uploadFile(t, worker.accessToken, 'WORK_PROOF');
  await api(t.app)
    .post(
      `${V1}/jobs/${jobId}/work-photos`,
      { kind, key },
      { token: worker.accessToken },
    )
    .expect(201);
}

/**
 * One "before" and one "after" photo on the job (real uploads, so deleting an account later finds real files).
 * Finishing the work requires both; a side that already has one is left alone.
 */
export async function withProofPhotos(
  t: TestApp,
  worker: Worker,
  jobId: string,
) {
  for (const kind of ['BEFORE', 'AFTER'] as const) {
    const stored = kind === 'BEFORE' ? 'BEFORE_PHOTO' : 'AFTER_PHOTO';
    if (
      (await t.prisma.jobMedia.count({ where: { jobId, kind: stored } })) === 0
    )
      await addProofPhoto(t, worker, jobId, kind);
  }
}

/** "Work complete". The server refuses it until the job has its proof photos: call `withProofPhotos` first. */
export function completeWork(t: TestApp, worker: Worker, jobId: string) {
  return api(t.app).post(
    `${V1}/jobs/${jobId}/complete-work`,
    {},
    { token: worker.accessToken },
  );
}

export function payFor(
  t: TestApp,
  customer: Customer,
  jobId: string,
  method: 'UPI' | 'CASH' = 'UPI',
) {
  return api(t.app).post(
    `${V1}/jobs/${jobId}/payment`,
    { method },
    { token: customer.accessToken },
  );
}

export const statusOf = async (t: TestApp, jobId: string) =>
  (await t.prisma.job.findUniqueOrThrow({ where: { id: jobId } })).status;

/** A job assigned to `worker` (as soon as possible): returns the arrival code the customer was given. */
export async function assigned(
  t: TestApp,
  customer: Customer,
  worker: Worker,
  overrides: Record<string, unknown> = {},
) {
  const job = await postJob(t, customer, overrides);
  const offer = await sendQuote(t, worker, job.id);
  const accepted = await acceptQuote(t, customer, job.id, offer.id).expect(200);
  return { job, offer, code: accepted.body.arrivalCode as string };
}

/** Assigned and the worker has arrived. */
export async function onSite(
  t: TestApp,
  customer: Customer,
  worker: Worker,
  overrides: Record<string, unknown> = {},
) {
  const made = await assigned(t, customer, worker, overrides);
  await arriveAt(t, worker, made.job.id, made.code).expect(200);
  return made;
}

/** Arrived, one extra bill line, approved: the work is under way. */
export async function underWay(
  t: TestApp,
  customer: Customer,
  worker: Worker,
  extra = 300,
) {
  const made = await onSite(t, customer, worker);
  await putItems(t, worker, made.job.id, [
    { kind: 'PARTS', description: 'PVC elbow joint', amount: extra },
  ]).expect(200);
  await approveBill(t, customer, made.job.id, VISIT_FEE + extra).expect(200);
  return { ...made, total: VISIT_FEE + extra };
}

/** Work finished, payment still to come. */
export async function finished(
  t: TestApp,
  customer: Customer,
  worker: Worker,
  extra = 300,
) {
  const made = await underWay(t, customer, worker, extra);
  await withProofPhotos(t, worker, made.job.id);
  await completeWork(t, worker, made.job.id).expect(200);
  return made;
}

/** The same scene for an appointment `minutes` from now, taken all the way to "arrived". */
export async function scheduledOnSite(
  t: TestApp,
  customer: Customer,
  worker: Worker,
  minutes: number,
) {
  const job = await scheduledJob(t, customer, minutes);
  const offer = await sendQuote(t, worker, job.id);
  const accepted = await acceptQuote(t, customer, job.id, offer.id).expect(200);
  return { job, offer, code: accepted.body.arrivalCode as string };
}

/** One login that holds BOTH a customer and a worker profile (the app lets a person switch modes). */
export async function bothProfiles(t: TestApp, area = 'Sector 22') {
  const me = await loginAs(t, nextPhone());
  const id = await areaId(t, area);
  const customer = await api(t.app)
    .put(`${V1}/customers/me`, customerPayload(id), { token: me.accessToken })
    .expect(200);
  await api(t.app)
    .put(`${V1}/workers/me`, workerPayload(id, { trades: ['plumber'] }), {
      token: me.accessToken,
    })
    .expect(200);
  await t.prisma.workerProfile.update({
    where: { userId: me.userId },
    data: { verificationStatus: 'VERIFIED' },
  });
  return {
    ...me,
    areaId: id,
    addressId: customer.body.addresses[0].id as string,
  };
}

export { customerIn, verifiedWorkerIn };
