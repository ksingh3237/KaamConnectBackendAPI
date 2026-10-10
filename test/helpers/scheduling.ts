import { api, type TestApp } from './app.js';
import type { Customer, Worker } from './marketplace.js';
import { postJob, sendQuote } from './marketplace.js';

export const V1 = '/api/v1';
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

/** An ISO time (with the Z offset the API requires) `minutes` from now. */
export const inMinutes = (minutes: number): string =>
  new Date(Date.now() + minutes * MINUTE).toISOString();

/** POST /jobs for an exact appointment `minutes` from now. */
export function scheduledJob(
  t: TestApp,
  customer: Customer,
  minutes: number,
  overrides: Record<string, unknown> = {},
) {
  return postJob(t, customer, {
    timing: 'SCHEDULED',
    scheduledFor: inMinutes(minutes),
    ...overrides,
  });
}

/** The customer taps "Accept" on a quote. Returns the pending request so a test can expect 200 or 409. */
export function acceptQuote(
  t: TestApp,
  customer: Customer,
  jobId: string,
  offerId: string,
) {
  return api(t.app).post(
    `${V1}/jobs/${jobId}/offers/${offerId}/accept`,
    {},
    { token: customer.accessToken },
  );
}

/** Whole happy path for a scheduled job: post, worker quotes, customer accepts. Expects the accept to work. */
export async function book(
  t: TestApp,
  customer: Customer,
  worker: Worker,
  minutes: number,
  overrides: Record<string, unknown> = {},
  quote: { etaMinutes?: number } = {},
) {
  const job = await scheduledJob(t, customer, minutes, overrides);
  const offer = await sendQuote(t, worker, job.id, quote);
  const accepted = await acceptQuote(t, customer, job.id, offer.id).expect(200);
  return { job, offer, accepted: accepted.body };
}

/** Same for an "as soon as possible" job: the booking window starts when the worker arrives (ETA). */
export async function bookNow(
  t: TestApp,
  customer: Customer,
  worker: Worker,
  overrides: Record<string, unknown> = {},
  quote: { etaMinutes?: number } = {},
) {
  const job = await postJob(t, customer, overrides);
  const offer = await sendQuote(t, worker, job.id, quote);
  const accepted = await acceptQuote(t, customer, job.id, offer.id).expect(200);
  return { job, offer, accepted: accepted.body };
}

/**
 * Moves a booked job to "work under way". The arrival and approval endpoints arrive with Phase 5,
 * so tests set the state directly, exactly as those endpoints will.
 */
export function startWork(t: TestApp, jobId: string) {
  return t.prisma.job.update({
    where: { id: jobId },
    data: {
      status: 'IN_PROGRESS',
      arrivedAt: new Date(),
      costApprovedAt: new Date(),
    },
  });
}

/** The worker's calendar as the app would fetch it. */
export async function scheduleOf(t: TestApp, worker: Worker) {
  const res = await api(t.app)
    .get(`${V1}/workers/me/schedule`, { token: worker.accessToken })
    .expect(200);
  return res.body as {
    inProgress: { jobId: string; startAt: string; endAt: string } | null;
    upcoming: {
      jobId: string;
      startAt: string;
      endAt: string;
      status: string;
    }[];
  };
}

/** The Leads Radar as the worker sees it. */
export async function feedOf(t: TestApp, worker: Worker, query = '') {
  const res = await api(t.app)
    .get(`${V1}/leads${query}`, { token: worker.accessToken })
    .expect(200);
  return res.body.items as {
    id: string;
    leadState: string;
    extendedReach: boolean;
    scheduledFor: string | null;
    availability: {
      free: boolean;
      etaOptions: number[] | null;
      reason: string | null;
      nextFreeAt: string | null;
    } | null;
  }[];
}
