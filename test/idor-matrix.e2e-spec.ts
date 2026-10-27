// IDOR matrix (docs/05-security-testing.md "AuthZ / IDOR"): every route that takes an object id in its path,
// called by people who do not own that object.
//
// For each route and each kind of intruder the answer for a REAL id must be exactly the answer for an id that
// does not exist (same status, same body), so a stranger cannot even learn that the object exists or what
// state it is in. Routes are deliberately called in a state that is wrong for the real owner (an arrival on a
// job that is only ASSIGNED, a payment before the work is done...), so that a state error (409) leaking
// through ahead of the ownership check would show up as a difference. After all of that, a fingerprint of
// every table an intruder could touch must be unchanged.
//
// A completeness guard enumerates the routes the application actually registers: adding a route with a path
// parameter without classifying it here fails the suite.

import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import { seedReferenceData } from '../prisma/seed/reference-data.js';
import { api, createTestApp, type TestApp } from './helpers/app.js';
import { loginAs } from './helpers/auth.js';
import { resetDatabase } from './helpers/db.js';
import { nextPhone } from './helpers/factories.js';
import {
  V1,
  assigned,
  customerIn,
  verifiedWorkerIn,
} from './helpers/fulfilment.js';
import { postJob, sendQuote, type Customer } from './helpers/marketplace.js';
import { scheduledJob } from './helpers/scheduling.js';

type Who = 'A' | 'B' | 'W' | 'X' | 'Z' | 'D';
type Verb = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface Ids {
  assigned: string; // A's job, ASSIGNED to W
  open: string; // A's scheduled request, OPEN, with a quote from Z
  offerOnOpen: string; // Z's quote on `open`
  direct: string; // A's direct booking, waiting for Z
  address: string; // A's address
  notification: string; // an unread inbox notification of A's
  worker: string; // a worker profile an admin could verify
  sos: string; // an SOS alert A raised on `assigned`
  requester: string; // a disabled user who asked for deletion (waits for an admin)
  category: string;
}

interface Case {
  route: string; // "METHOD /path/with/:params", exactly as the application registers it
  path: (ids: Ids, primary: string) => string;
  body?: object;
  /** The primary id is taken from here (the resource the route is about). */
  resource: keyof Ids;
  /** Right kind of user, but not the owner: must get 404, identical to an unknown id. */
  strangers: Who[];
  /** Wrong kind of user altogether: must get 403, identical to an unknown id. */
  wrongRole: Who[];
  /** Owners, only exercised on GET routes (to prove the ids in the matrix are real). */
  owners?: Who[];
}

const UNKNOWN = '0197a0c0-0000-7000-8000-000000000000';
const CUSTOMER_ROUTE = {
  strangers: ['B'] as Who[],
  wrongRole: ['W', 'X', 'Z'] as Who[],
};
const WORKER_JOB_ROUTE = {
  strangers: ['X', 'Z'] as Who[],
  wrongRole: ['A', 'B'] as Who[],
};
const ANYONE_JOB_ROUTE = {
  strangers: ['B', 'X', 'Z'] as Who[],
  wrongRole: [] as Who[],
};

const job =
  (suffix = '') =>
  (ids: Ids, id: string) =>
    `${V1}/jobs/${id}${suffix}`;

const CASES: Case[] = [
  // ── a job, for either party (anyone else: 404) ──
  {
    route: 'GET /jobs/:id',
    resource: 'assigned',
    path: job(),
    ...ANYONE_JOB_ROUTE,
    owners: ['A', 'W'],
  },
  {
    route: 'GET /jobs/:id/bill',
    resource: 'assigned',
    path: job('/bill'),
    ...ANYONE_JOB_ROUTE,
    owners: ['A', 'W'],
  },
  {
    route: 'GET /jobs/:id/receipt',
    resource: 'assigned',
    path: job('/receipt'),
    ...ANYONE_JOB_ROUTE,
    owners: ['A', 'W'],
  },
  {
    route: 'GET /jobs/:id/tracking',
    resource: 'assigned',
    path: job('/tracking'),
    ...ANYONE_JOB_ROUTE,
    owners: ['A', 'W'],
  },
  {
    route: 'POST /jobs/:id/cancel',
    resource: 'assigned',
    path: job('/cancel'),
    body: {},
    // One route for two parties: the customer cancels, the assigned worker backs out. A caller who is
    // neither is treated as a would-be customer, so a non-customer (a worker who is not on the job) gets
    // 403 and another customer gets 404, in both cases exactly what an unknown id gets.
    strangers: ['B'],
    wrongRole: ['X', 'Z'],
  },
  {
    route: 'POST /jobs/:id/sos',
    resource: 'assigned',
    path: job('/sos'),
    body: {},
    ...ANYONE_JOB_ROUTE,
  },

  // The caller's own alerts on a job they are on; anyone else gets the same 404 as for an unknown job.
  {
    route: 'GET /jobs/:id/sos',
    resource: 'assigned',
    path: job('/sos'),
    ...ANYONE_JOB_ROUTE,
    owners: ['A', 'W'],
  },

  // ── the job's customer ──
  {
    route: 'GET /jobs/:id/offers',
    resource: 'open',
    path: job('/offers'),
    ...CUSTOMER_ROUTE,
    owners: ['A'],
  },
  {
    route: 'POST /jobs/:id/offers/:offerId/accept',
    resource: 'open',
    path: (ids, id) => `${V1}/jobs/${id}/offers/${ids.offerOnOpen}/accept`,
    body: {},
    ...CUSTOMER_ROUTE,
  },
  {
    route: 'POST /jobs/:id/arrival-code/reset',
    resource: 'assigned',
    path: job('/arrival-code/reset'),
    body: {},
    ...CUSTOMER_ROUTE,
  },
  {
    route: 'POST /jobs/:id/bill/approve',
    resource: 'assigned',
    path: job('/bill/approve'),
    body: { expectedTotal: 250 },
    ...CUSTOMER_ROUTE,
  },
  {
    route: 'POST /jobs/:id/payment',
    resource: 'assigned',
    path: job('/payment'),
    body: { method: 'CASH' },
    ...CUSTOMER_ROUTE,
  },
  {
    route: 'POST /jobs/:id/review',
    resource: 'assigned',
    path: job('/review'),
    body: { rating: 5 },
    ...CUSTOMER_ROUTE,
  },

  // ── the job's assigned worker ──
  {
    route: 'POST /jobs/:id/arrival',
    resource: 'assigned',
    path: job('/arrival'),
    body: { code: '1234' },
    ...WORKER_JOB_ROUTE,
  },
  {
    route: 'PUT /jobs/:id/bill-items',
    resource: 'assigned',
    path: job('/bill-items'),
    body: { items: [{ kind: 'PARTS', description: 'Pipe', amount: 100 }] },
    ...WORKER_JOB_ROUTE,
  },
  {
    route: 'POST /jobs/:id/work-photos',
    resource: 'assigned',
    path: job('/work-photos'),
    body: { kind: 'BEFORE', key: 'work-proof/someone/else.jpg' },
    ...WORKER_JOB_ROUTE,
  },
  {
    route: 'POST /jobs/:id/complete-work',
    resource: 'assigned',
    path: job('/complete-work'),
    body: {},
    ...WORKER_JOB_ROUTE,
  },

  // ── a direct request, visible only to the worker it was sent to (Z) ──
  {
    route: 'POST /jobs/:id/direct/accept',
    resource: 'direct',
    path: job('/direct/accept'),
    body: {},
    strangers: ['W', 'X'],
    wrongRole: ['A', 'B'],
  },
  {
    route: 'POST /jobs/:id/direct/decline',
    resource: 'direct',
    path: job('/direct/decline'),
    body: {},
    strangers: ['W', 'X'],
    wrongRole: ['A', 'B'],
  },

  // ── leads: visible to workers who cover the place and trade (W, Z); X (an electrician) must not see them ──
  {
    route: 'GET /leads/:id',
    resource: 'open',
    path: (_ids, id) => `${V1}/leads/${id}`,
    strangers: ['X'],
    wrongRole: ['A', 'B'],
    owners: ['W', 'Z'],
  },
  {
    route: 'POST /leads/:id/accept',
    resource: 'open',
    path: (_ids, id) => `${V1}/leads/${id}/accept`,
    body: {},
    strangers: ['X'],
    wrongRole: ['A', 'B'],
  },
  {
    route: 'POST /leads/:id/decline',
    resource: 'open',
    path: (_ids, id) => `${V1}/leads/${id}/decline`,
    body: {},
    strangers: ['X'],
    wrongRole: ['A', 'B'],
  },
  {
    route: 'POST /leads/:id/offers',
    resource: 'open',
    path: (_ids, id) => `${V1}/leads/${id}/offers`,
    body: { visitFee: 250, etaMinutes: 15 },
    strangers: ['X'],
    wrongRole: ['A', 'B'],
  },

  // ── a quote, owned by the worker who sent it (Z) ──
  {
    route: 'PATCH /offers/:id',
    resource: 'offerOnOpen',
    path: (_ids, id) => `${V1}/offers/${id}`,
    body: { visitFee: 300 },
    strangers: ['W', 'X'],
    wrongRole: ['A', 'B'],
  },
  {
    route: 'DELETE /offers/:id',
    resource: 'offerOnOpen',
    path: (_ids, id) => `${V1}/offers/${id}`,
    strangers: ['W', 'X'],
    wrongRole: ['A', 'B'],
  },

  // ── the customer's address book ──
  {
    route: 'PATCH /customers/me/addresses/:id',
    resource: 'address',
    path: (_ids, id) => `${V1}/customers/me/addresses/${id}`,
    body: { line: '12 Some Other Street' },
    ...CUSTOMER_ROUTE,
  },
  {
    route: 'DELETE /customers/me/addresses/:id',
    resource: 'address',
    path: (_ids, id) => `${V1}/customers/me/addresses/${id}`,
    ...CUSTOMER_ROUTE,
  },
  // ── the inbox: any signed-in person may call it, but only the owner's notification exists for them ──
  {
    route: 'PATCH /notifications/:id/read',
    resource: 'notification',
    path: (_ids, id) => `${V1}/notifications/${id}/read`,
    body: {},
    strangers: ['B', 'W', 'X', 'Z', 'D'],
    wrongRole: [],
  },
  {
    route: 'POST /customers/me/addresses/:id/primary',
    resource: 'address',
    path: (_ids, id) => `${V1}/customers/me/addresses/${id}/primary`,
    body: {},
    ...CUSTOMER_ROUTE,
  },

  // ── admin only: everyone who is not an admin gets 404, as if the API did not exist ──
  {
    route: 'POST /admin/workers/:id/verify',
    resource: 'worker',
    path: (_ids, id) => `${V1}/admin/workers/${id}/verify`,
    body: {},
    strangers: ['A', 'B', 'W', 'X', 'Z'],
    wrongRole: [],
  },
  {
    route: 'POST /admin/cancellations/:id/excuse',
    resource: 'worker', // any id: a non-admin is turned away before the id is looked at
    path: (_ids, id) => `${V1}/admin/cancellations/${id}/excuse`,
    body: {},
    strangers: ['A', 'B', 'W', 'X', 'Z'],
    wrongRole: [],
  },
  {
    route: 'POST /admin/workers/:id/reject',
    resource: 'worker',
    path: (_ids, id) => `${V1}/admin/workers/${id}/reject`,
    body: { reason: 'Photo unclear' },
    strangers: ['A', 'B', 'W', 'X', 'Z'],
    wrongRole: [],
  },
  {
    route: 'PATCH /admin/service-categories/:id/duration',
    resource: 'category',
    path: (_ids, id) => `${V1}/admin/service-categories/${id}/duration`,
    body: { defaultDurationMin: 60 },
    strangers: ['A', 'B', 'W', 'X', 'Z'],
    wrongRole: [],
  },
  {
    route: 'POST /admin/sos/:id/acknowledge',
    resource: 'sos',
    path: (_ids, id) => `${V1}/admin/sos/${id}/acknowledge`,
    body: {},
    strangers: ['A', 'B', 'W', 'X', 'Z'],
    wrongRole: [],
  },
  {
    route: 'POST /admin/sos/:id/resolve',
    resource: 'sos',
    path: (_ids, id) => `${V1}/admin/sos/${id}/resolve`,
    body: {},
    strangers: ['A', 'B', 'W', 'X', 'Z'],
    wrongRole: [],
  },
  {
    route: 'POST /admin/deletion-requests/:userId/approve',
    resource: 'requester',
    path: (_ids, id) => `${V1}/admin/deletion-requests/${id}/approve`,
    body: {},
    strangers: ['A', 'B', 'W', 'X', 'Z'],
    wrongRole: [],
  },
  {
    route: 'POST /admin/deletion-requests/:userId/decline',
    resource: 'requester',
    path: (_ids, id) => `${V1}/admin/deletion-requests/${id}/decline`,
    body: {},
    strangers: ['A', 'B', 'W', 'X', 'Z'],
    wrongRole: [],
  },
];

/** Routes with a path parameter that are not owner-scoped objects, and why they are not in the matrix. */
const EXEMPT: Record<string, string> = {
  'GET /workers/:id':
    'a verified worker profile is public to every customer by design; unverified ones are 404 (tested below)',
  'PUT /workers/me/documents/:type':
    ':type is a fixed list (AADHAAR_FRONT / AADHAAR_BACK), not an object id; it always acts on the caller',
  'GET /dev-storage/:bucket/*key':
    'development stand-in for S3, authorised by a signed URL (media.e2e-spec)',
  'PUT /dev-storage/:bucket/*key':
    'development stand-in for S3, authorised by a signed URL (media.e2e-spec)',
};

describe('IDOR matrix: every route with an id, called by people who do not own it (e2e)', () => {
  let t: TestApp;
  let http: ReturnType<typeof api>;
  let ids: Ids;
  const token: Record<Who, string> = {
    A: '',
    B: '',
    W: '',
    X: '',
    Z: '',
    D: '',
  };
  let before: string;
  let customerB: Customer;

  /** A fingerprint of every table an intruder could change: any write, even a touched `updated_at`, shows. */
  async function fingerprint(): Promise<string> {
    const tables = [
      'jobs',
      'offers',
      'bill_items',
      'payments',
      'reviews',
      'sos_alerts',
      'job_media',
      'addresses',
      'worker_profiles',
      'customer_profiles',
      'worker_leads',
      'job_security_events',
      'job_cancellations',
      'worker_documents',
      'service_categories',
      // just the one notification: other inbox rows are written asynchronously by the setup's own bookings
      `(SELECT * FROM in_app_notifications WHERE id = '${ids.notification}')`,
    ];
    const parts: string[] = [];
    for (const table of tables) {
      const rows = await t.prisma.$queryRawUnsafe<{ h: string | null }[]>(
        `SELECT md5(string_agg(row_to_json(x)::text, '|' ORDER BY row_to_json(x)::text)) AS h FROM ${table} x`,
      );
      parts.push(`${table}=${rows[0]?.h ?? 'empty'}`);
    }
    return parts.join(';');
  }

  const call = (verb: Verb, path: string, who: Who | null, body?: object) => {
    const opts = who ? { token: token[who] } : {};
    switch (verb) {
      case 'GET':
        return http.get(path, opts);
      case 'DELETE':
        return http.delete(path, opts);
      case 'POST':
        return http.post(path, body ?? {}, opts);
      case 'PUT':
        return http.put(path, body ?? {}, opts);
      case 'PATCH':
        return http.patch(path, body ?? {}, opts);
    }
  };

  beforeAll(async () => {
    t = await createTestApp();
    http = api(t.app);
    await resetDatabase(t.prisma);
    await seedReferenceData(t.prisma);

    const A = await customerIn(t);
    const B = await customerIn(t);
    customerB = B;
    const W = await verifiedWorkerIn(t, { trades: ['plumber'] });
    const Z = await verifiedWorkerIn(t, { trades: ['plumber'] });
    const X = await verifiedWorkerIn(t, { trades: ['electrician'] });
    const D = await loginAs(t, nextPhone());
    await t.prisma.user.update({
      where: { id: D.userId },
      data: { isAdmin: true },
    });
    Object.assign(token, {
      A: A.accessToken,
      B: B.accessToken,
      W: W.accessToken,
      X: X.accessToken,
      Z: Z.accessToken,
      D: D.accessToken,
    });

    // A's job, ASSIGNED to W.
    const made = await assigned(t, A, W);
    // A's second request, OPEN (scheduled, so it does not clash with W's booking), with a quote from Z.
    const open = await scheduledJob(t, A, 300);
    const quote = await sendQuote(t, Z, open.id);
    // A's direct booking to Z, waiting for Z to answer.
    const booked = await http
      .post(
        `${V1}/jobs/direct-booking`,
        {
          categoryId: 'plumber',
          title: 'Geyser not working',
          timing: 'IMMEDIATE',
          addressId: A.addressId,
          workerId: Z.userId,
        },
        { token: A.accessToken },
      )
      .expect(201);

    // A raised an SOS on the assigned job (stored directly: raising one over HTTP is covered by the SOS suites)
    const alert = await t.prisma.sosAlert.create({
      data: { userId: A.userId, jobId: made.job.id },
    });
    // a disabled person who asked for deletion, waiting for an admin
    const requester = await loginAs(t, nextPhone());
    await t.prisma.user.update({
      where: { id: requester.userId },
      data: { isActive: false, deletionRequestedAt: new Date() },
    });

    const notification = await t.prisma.inAppNotification.create({
      data: {
        userId: A.userId,
        type: 'NEW_QUOTE',
        title: 'New quote',
        body: 'x',
      },
    });

    ids = {
      notification: notification.id,
      sos: alert.id,
      requester: requester.userId,
      assigned: made.job.id,
      open: open.id,
      offerOnOpen: quote.id,
      direct: booked.body.id as string,
      address: A.addressId,
      worker: W.userId,
      category: 'plumber',
    };
    // The ids in the matrix must be real, or "same answer as an unknown id" would prove nothing.
    expect(
      await t.prisma.job.count({
        where: { id: { in: [ids.assigned, ids.open, ids.direct] } },
      }),
    ).toBe(3);
    expect(await t.prisma.offer.count({ where: { id: ids.offerOnOpen } })).toBe(
      1,
    );
    expect(await t.prisma.address.count({ where: { id: ids.address } })).toBe(
      1,
    );
    expect(
      (await t.prisma.job.findUniqueOrThrow({ where: { id: ids.assigned } }))
        .status,
    ).toBe('ASSIGNED');
    expect(
      (await t.prisma.job.findUniqueOrThrow({ where: { id: ids.direct } }))
        .targetWorkerId,
    ).toBe(Z.userId);

    before = await fingerprint();
  });
  afterAll(async () => {
    await t.close();
  });

  it('completeness guard: every route the application registers that has a path parameter is classified here', () => {
    const registered = new Set<string>();
    for (const module of t.app.get(ModulesContainer).values()) {
      for (const wrapper of module.controllers.values()) {
        const controller = wrapper.metatype as
          (new (...args: never[]) => object) | null;
        if (!controller) continue;
        const base = String(
          Reflect.getMetadata(PATH_METADATA, controller) ?? '',
        );
        for (const name of Object.getOwnPropertyNames(controller.prototype)) {
          const handler = (controller.prototype as Record<string, unknown>)[
            name
          ];
          if (typeof handler !== 'function' || name === 'constructor') continue;
          const method = Reflect.getMetadata(METHOD_METADATA, handler) as
            number | undefined;
          if (method === undefined) continue;
          const sub = String(Reflect.getMetadata(PATH_METADATA, handler) ?? '');
          const path = ('/' + base + '/' + sub)
            .replace(/\/+/g, '/')
            .replace(/\/$/, '');
          if (path.includes(':'))
            registered.add(`${RequestMethod[method]} ${path}`);
        }
      }
    }
    const classified = new Set([
      ...CASES.map((c) => c.route),
      ...Object.keys(EXEMPT),
    ]);
    expect({
      unclassified: [...registered].filter((r) => !classified.has(r)).sort(),
      stale: [...classified].filter((r) => !registered.has(r)).sort(),
    }).toEqual({ unclassified: [], stale: [] });
    expect(registered.size).toBe(41);
  });

  describe.each(CASES)('$route', (c) => {
    const verb = c.route.split(' ')[0] as Verb;

    it('a stranger of the right kind gets 404, identical to an unknown id, and changes nothing', async () => {
      for (const who of c.strangers) {
        const real = await call(
          verb,
          c.path(ids, ids[c.resource]),
          who,
          c.body,
        );
        const unknown = await call(verb, c.path(ids, UNKNOWN), who, c.body);
        expect({ who, status: real.status, body: real.body }).toEqual({
          who,
          status: 404,
          body: unknown.body,
        });
        expect(unknown.status).toBe(404);
      }
    });

    it('a user of the wrong kind gets 403, identical to an unknown id', async () => {
      for (const who of c.wrongRole) {
        const real = await call(
          verb,
          c.path(ids, ids[c.resource]),
          who,
          c.body,
        );
        const unknown = await call(verb, c.path(ids, UNKNOWN), who, c.body);
        expect({ who, status: real.status, body: real.body }).toEqual({
          who,
          status: 403,
          body: unknown.body,
        });
      }
    });

    it('nobody without a login gets in (401)', async () => {
      const res = await call(verb, c.path(ids, ids[c.resource]), null, c.body);
      expect(res.status).toBe(401);
    });

    if (verb === 'GET' && c.owners) {
      it('the owners can see it (so the ids used above are real)', async () => {
        for (const who of c.owners ?? []) {
          const res = await call(verb, c.path(ids, ids[c.resource]), who);
          expect({
            who,
            status: res.status < 400 || res.status === 409,
          }).toEqual({ who, status: true });
        }
      });
    }
  });

  it('after every refused call above, nothing a stranger could touch has changed', async () => {
    expect(await fingerprint()).toEqual(before);
  });

  it("another customer's own job cannot be paired with this quote to accept it (cross-resource)", async () => {
    const own = await postJob(t, customerB, { title: 'My own request' });
    const res = await http.post(
      `${V1}/jobs/${own.id}/offers/${ids.offerOnOpen}/accept`,
      {},
      { token: token.B },
    );
    expect(res.status).toBe(404);
    expect(
      (
        await t.prisma.offer.findUniqueOrThrow({
          where: { id: ids.offerOnOpen },
        })
      ).status,
    ).toBe('PENDING');
    expect(
      (await t.prisma.job.findUniqueOrThrow({ where: { id: own.id } })).status,
    ).toBe('OPEN');
  });

  it('GET /workers/:id: an unverified profile looks exactly like an unknown id, and a worker cannot use the customer route', async () => {
    const unverified = await verifiedWorkerIn(t, { verified: false });
    const res = await http.get(`${V1}/workers/${unverified.userId}`, {
      token: token.A,
    });
    const unknown = await http.get(`${V1}/workers/${UNKNOWN}`, {
      token: token.A,
    });
    expect([res.status, res.body]).toEqual([404, unknown.body]);
    await http
      .get(`${V1}/workers/${ids.worker}`, { token: token.W })
      .expect(403);
  });
});
