import { api, type TestApp } from './app.js';
import { loginAs, type LoggedIn } from './auth.js';
import { nextPhone } from './factories.js';
import { customerPayload, workerPayload } from './personas.js';

const V1 = '/api/v1';

/** Approximate Tricity coordinates, used only to exercise the distance rules in tests. */
export const PLACES = {
  'Sector 22': { lat: 30.7333, lng: 76.7794 },
  'Sector 35': { lat: 30.724, lng: 76.758 }, // about 2.3 km from Sector 22
  'Phase 7': { lat: 30.711, lng: 76.72 }, // about 6.4 km from Sector 22
} as const;

export async function areaId(
  t: TestApp,
  name: string,
  city = 'Chandigarh',
): Promise<number> {
  const area = await t.prisma.area.findFirstOrThrow({
    where: { name, city: { name: city } },
  });
  return area.id;
}

/** Fills an area's centroid so tests can use the radius rule instead of the same-city fallback. */
export async function giveCoordinates(
  t: TestApp,
  name: keyof typeof PLACES,
  city = 'Chandigarh',
): Promise<void> {
  await t.prisma.area.update({
    where: { id: await areaId(t, name, city) },
    data: PLACES[name],
  });
}

export interface Customer extends LoggedIn {
  areaId: number;
  addressId: string;
}

/** A signed-in customer with a profile and a primary address in `area`. */
export async function customerIn(
  t: TestApp,
  area = 'Sector 22',
  city = 'Chandigarh',
): Promise<Customer> {
  const me = await loginAs(t, nextPhone());
  const id = await areaId(t, area, city);
  const res = await api(t.app)
    .put(`${V1}/customers/me`, customerPayload(id), { token: me.accessToken })
    .expect(200);
  return { ...me, areaId: id, addressId: res.body.addresses[0].id };
}

export interface Worker extends LoggedIn {
  baseAreaId: number;
}

/** A signed-in, VERIFIED worker. Verification is set directly: its rules are tested in workers/admin suites. */
export async function verifiedWorkerIn(
  t: TestApp,
  options: {
    area?: string;
    city?: string;
    trades?: string[];
    radiusKm?: number;
    visitingFee?: number;
    fullName?: string;
    verified?: boolean;
  } = {},
): Promise<Worker> {
  const me = await loginAs(t, nextPhone());
  const id = await areaId(
    t,
    options.area ?? 'Sector 22',
    options.city ?? 'Chandigarh',
  );
  await api(t.app)
    .put(
      `${V1}/workers/me`,
      workerPayload(id, {
        trades: options.trades ?? ['plumber'],
        radiusKm: options.radiusKm ?? 6,
        fullName: options.fullName ?? 'Test Worker',
        ...(options.visitingFee !== undefined
          ? { visitingFee: options.visitingFee }
          : {}),
      }),
      { token: me.accessToken },
    )
    .expect(200);
  if (options.verified !== false) {
    await t.prisma.workerProfile.update({
      where: { userId: me.userId },
      data: { verificationStatus: 'VERIFIED' },
    });
  }
  return { ...me, baseAreaId: id };
}

/** POST /jobs as `customer` and return the response body. */
export async function postJob(
  t: TestApp,
  customer: Customer,
  overrides: Record<string, unknown> = {},
) {
  const res = await api(t.app)
    .post(
      `${V1}/jobs`,
      {
        categoryId: 'plumber',
        title: 'Kitchen sink pipe burst',
        description: 'PVC pipe cracked under the sink',
        timing: 'IMMEDIATE',
        addressId: customer.addressId,
        ...overrides,
      },
      { token: customer.accessToken },
    )
    .expect(201);
  return res.body as {
    id: string;
    jobNumber: number;
    reference: string;
    status: string;
    expiresAt: string;
    scheduledFor: string | null;
    durationMin: number;
    notifiedWorkers?: number;
  };
}

export async function sendQuote(
  t: TestApp,
  worker: Worker,
  jobId: string,
  body: { visitFee?: number; etaMinutes?: number; message?: string } = {},
) {
  const res = await api(t.app)
    .post(
      `${V1}/leads/${jobId}/offers`,
      { visitFee: 250, etaMinutes: 15, ...body },
      { token: worker.accessToken },
    )
    .expect(201);
  return res.body as {
    id: string;
    visitFee: number;
    etaMinutes: number;
    status: string;
  };
}
