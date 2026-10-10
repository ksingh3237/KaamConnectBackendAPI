import request from 'supertest';
import type { MediaPurpose } from '../../src/modules/media/media-rules.js';
import { api, freshIp, type TestApp } from './app.js';
import { loginAs, type LoggedIn } from './auth.js';
import { nextPhone } from './factories.js';

const V1 = '/api/v1';

/** Real two-step upload: ask for a signed URL, then PUT the bytes to it. Returns the storage key. */
export async function uploadFile(
  t: TestApp,
  token: string,
  purpose: MediaPurpose,
  options: { contentType?: string; bytes?: number } = {},
): Promise<{ key: string; uploadUrl: string }> {
  const contentType =
    options.contentType ??
    (purpose === 'JOB_VOICE' ? 'audio/mp4' : 'image/jpeg');
  const body = Buffer.alloc(options.bytes ?? 2048, 7);

  const presign = await api(t.app)
    .post(
      `${V1}/media/presign`,
      { purpose, contentType, sizeBytes: body.length },
      { token },
    )
    .expect(200);

  const url = new URL(presign.body.uploadUrl);
  await request(t.app.getHttpServer())
    .put(url.pathname + url.search)
    .set(presign.body.headers)
    .set('X-Forwarded-For', freshIp())
    .send(body)
    .expect(200);
  return { key: presign.body.key, uploadUrl: presign.body.uploadUrl };
}

export const customerPayload = (
  areaId: number,
  overrides: Record<string, unknown> = {},
) => ({
  fullName: 'Sunita Sharma',
  commLanguage: 'hi',
  allowDirectCalls: true,
  address: { areaId, line: 'House #1402, Near Subhash Park' },
  ...overrides,
});

export const workerPayload = (
  areaId: number,
  overrides: Record<string, unknown> = {},
) => ({
  fullName: 'Rajesh Kumar',
  trades: ['electrician', 'appliance'],
  experienceYears: 8,
  skills: ['Wiring', 'MCB Box Repair', 'Fan Repair'],
  languages: ['hi', 'pa'],
  baseAreaId: areaId,
  radiusKm: 6,
  termsAccepted: true,
  ...overrides,
});

/** A signed-in user (real login) plus the id of a seeded area to build payloads with. */
export async function newUser(t: TestApp): Promise<LoggedIn> {
  return loginAs(t, nextPhone());
}

export async function anAreaId(t: TestApp): Promise<number> {
  return (await t.prisma.area.findFirstOrThrow({ orderBy: { id: 'asc' } })).id;
}

/** Creates a worker profile and uploads both Aadhaar sides. Returns the logged-in worker. */
export async function onboardedWorker(
  t: TestApp,
  overrides: Record<string, unknown> = {},
): Promise<LoggedIn & { areaId: number }> {
  const me = await newUser(t);
  const areaId = await anAreaId(t);
  const http = api(t.app);
  await http
    .put(`${V1}/workers/me`, workerPayload(areaId, overrides), {
      token: me.accessToken,
    })
    .expect(200);
  for (const type of ['AADHAAR_FRONT', 'AADHAAR_BACK']) {
    const { key } = await uploadFile(t, me.accessToken, 'AADHAAR');
    await http
      .put(
        `${V1}/workers/me/documents/${type}`,
        { key },
        { token: me.accessToken },
      )
      .expect(200);
  }
  return { ...me, areaId };
}

/** Flags an existing user as admin (there is intentionally no API for this). */
export async function makeAdmin(t: TestApp, userId: string): Promise<void> {
  await t.prisma.user.update({
    where: { id: userId },
    data: { isAdmin: true },
  });
}
