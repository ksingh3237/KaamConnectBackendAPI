import request from 'supertest';
import { seedReferenceData } from '../prisma/seed/reference-data.js';
import { api, createTestApp, freshIp, type TestApp } from './helpers/app.js';
import { resetDatabase } from './helpers/db.js';
import {
  anAreaId,
  customerPayload,
  newUser,
  uploadFile,
  workerPayload,
} from './helpers/personas.js';

const V1 = '/api/v1';
const ME = `${V1}/customers/me`;
const ADDRESSES = `${ME}/addresses`;

describe('customer profile and addresses (e2e, real PostgreSQL)', () => {
  let t: TestApp;
  let http: ReturnType<typeof api>;
  let areaId: number;

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
    areaId = await anAreaId(t);
  });

  async function customer(overrides: Record<string, unknown> = {}) {
    const me = await newUser(t);
    const res = await http
      .put(ME, customerPayload(areaId, overrides), { token: me.accessToken })
      .expect(200);
    return { ...me, profile: res.body };
  }

  describe('PUT /customers/me (onboarding save)', () => {
    it('creates the profile with its primary address', async () => {
      const me = await newUser(t);
      const res = await http
        .put(ME, customerPayload(areaId), { token: me.accessToken })
        .expect(200);

      expect(res.body).toMatchObject({
        userId: me.userId,
        fullName: 'Sunita Sharma',
        photoUrl: null,
        commLanguage: 'hi',
        allowDirectCalls: true,
      });
      expect(res.body.addresses).toEqual([
        {
          id: expect.any(String),
          area: { id: areaId, name: 'Sector 15' },
          city: { id: expect.any(Number), name: 'Chandigarh' },
          line: 'House #1402, Near Subhash Park',
          lat: null,
          lng: null,
          isPrimary: true,
        },
      ]);
    });

    it('is idempotent: saving twice keeps one profile and one address', async () => {
      const me = await newUser(t);
      await http
        .put(ME, customerPayload(areaId), { token: me.accessToken })
        .expect(200);
      await http
        .put(ME, customerPayload(areaId), { token: me.accessToken })
        .expect(200);

      expect(await t.prisma.customerProfile.count()).toBe(1);
      expect(await t.prisma.address.count()).toBe(1);
    });

    it('updates the existing profile and primary address in place; omitted options stay as they were', async () => {
      const first = await customer({
        commLanguage: 'pa',
        allowDirectCalls: false,
      });
      const otherArea = (
        await t.prisma.area.findMany({ orderBy: { id: 'asc' } })
      )[3]!;

      const res = await http
        .put(
          ME,
          {
            fullName: 'Sunita S.',
            address: {
              areaId: otherArea.id,
              line: 'Flat 302, Royal Residency',
              lat: 30.7333,
              lng: 76.7794,
            },
          },
          { token: first.accessToken },
        )
        .expect(200);

      expect(res.body).toMatchObject({
        fullName: 'Sunita S.',
        commLanguage: 'pa',
        allowDirectCalls: false,
      });
      expect(res.body.addresses).toHaveLength(1);
      expect(res.body.addresses[0]).toMatchObject({
        id: first.profile.addresses[0].id, // same row, edited
        area: { id: otherArea.id },
        line: 'Flat 302, Royal Residency',
        lat: 30.7333,
        lng: 76.7794,
      });
    });

    it('trims the name and address', async () => {
      const me = await newUser(t);
      const res = await http
        .put(
          ME,
          customerPayload(areaId, {
            fullName: '  Sunita  ',
            address: { areaId, line: '  House 5  ' },
          }),
          {
            token: me.accessToken,
          },
        )
        .expect(200);
      expect(res.body.fullName).toBe('Sunita');
      expect(res.body.addresses[0].line).toBe('House 5');
    });

    it.each([
      ['blank name', { fullName: '   ' }, 'fullName'],
      ['empty name', { fullName: '' }, 'fullName'],
      ['81-character name', { fullName: 'x'.repeat(81) }, 'fullName'],
      ['unknown language', { commLanguage: 'fr' }, 'commLanguage'],
      ['non-boolean toggle', { allowDirectCalls: 'yes' }, 'allowDirectCalls'],
      ['missing address', { address: undefined }, 'address'],
      [
        'too-short address line',
        { address: { areaId: 1, line: 'x' } },
        'address.line',
      ],
      [
        '201-character address line',
        { address: { areaId: 1, line: 'x'.repeat(201) } },
        'address.line',
      ],
      [
        'latitude without longitude',
        { address: { areaId: 1, line: 'House 1', lat: 30.7 } },
        'address.lng',
      ],
      [
        'longitude without latitude',
        { address: { areaId: 1, line: 'House 1', lng: 76.7 } },
        'address.lat',
      ],
      [
        'latitude out of range',
        { address: { areaId: 1, line: 'House 1', lat: 91, lng: 76 } },
        'address.lat',
      ],
      [
        'longitude out of range',
        { address: { areaId: 1, line: 'House 1', lat: 30, lng: 181 } },
        'address.lng',
      ],
      [
        'non-numeric area',
        { address: { areaId: 'sector 22', line: 'House 1' } },
        'address.areaId',
      ],
    ])(
      'rejects %s with a 422 naming the field',
      async (_label, overrides, field) => {
        const me = await newUser(t);
        const res = await http
          .put(
            ME,
            { ...customerPayload(areaId), ...overrides },
            { token: me.accessToken },
          )
          .expect(422);
        expect(res.body.code).toBe('VALIDATION_FAILED');
        expect(
          res.body.details.map((d: { field: string }) => d.field),
        ).toContain(field);
      },
    );

    it('rejects an area that does not exist', async () => {
      const me = await newUser(t);
      const res = await http
        .put(ME, customerPayload(999999), { token: me.accessToken })
        .expect(422);
      expect(res.body.details).toEqual([
        { field: 'address.areaId', issue: 'unknown area' },
      ]);
      expect(await t.prisma.customerProfile.count()).toBe(0);
    });

    it('ignores nothing silently: unknown fields (e.g. trying to set userId) are rejected', async () => {
      const me = await newUser(t);
      const other = await newUser(t);
      const res = await http
        .put(
          ME,
          customerPayload(areaId, { userId: other.userId, isAdmin: true }),
          { token: me.accessToken },
        )
        .expect(422);
      expect(
        res.body.details.map((d: { field: string }) => d.field).sort(),
      ).toEqual(['isAdmin', 'userId']);
      expect(await t.prisma.customerProfile.count()).toBe(0);
    });

    it('requires login', async () => {
      await http.put(ME, customerPayload(areaId)).expect(401);
    });

    it('makes the login response and /me report the new profile', async () => {
      const me = await customer();
      const res = await http
        .get(`${V1}/me`, { token: me.accessToken })
        .expect(200);
      expect(res.body.customer).toEqual({
        fullName: 'Sunita Sharma',
        commLanguage: 'hi',
        allowDirectCalls: true,
      });
    });
  });

  describe('profile photo', () => {
    it('accepts a key the user uploaded and returns a working read link', async () => {
      const me = await newUser(t);
      const { key } = await uploadFile(t, me.accessToken, 'PROFILE_PHOTO');
      const res = await http
        .put(ME, customerPayload(areaId, { photoKey: key }), {
          token: me.accessToken,
        })
        .expect(200);

      expect(res.body.photoUrl).toContain('/dev-storage/media/');
      const url = new URL(res.body.photoUrl);
      await request(t.app.getHttpServer())
        .get(url.pathname + url.search)
        .set('X-Forwarded-For', freshIp())
        .expect(200);
      // Only the short-lived link is returned, never the stored key field itself.
      expect(res.body).not.toHaveProperty('photoKey');
      expect(res.body).not.toHaveProperty('storageKey');
    });

    it('rejects a key that belongs to another user', async () => {
      const mine = await newUser(t);
      const theirs = await newUser(t);
      const { key } = await uploadFile(t, theirs.accessToken, 'PROFILE_PHOTO');

      const res = await http
        .put(ME, customerPayload(areaId, { photoKey: key }), {
          token: mine.accessToken,
        })
        .expect(422);
      expect(res.body.details[0]).toMatchObject({ field: 'photoKey' });
      expect(await t.prisma.customerProfile.count()).toBe(0);
    });

    it('rejects a well-formed key for a file that was never uploaded', async () => {
      const me = await newUser(t);
      const fake = `u/${me.userId}/PROFILE_PHOTO/00000000-0000-4000-8000-000000000000.jpg`;
      const res = await http
        .put(ME, customerPayload(areaId, { photoKey: fake }), {
          token: me.accessToken,
        })
        .expect(422);
      expect(res.body.details[0].issue).toContain('not been uploaded');
    });

    it('rejects a key uploaded for a different purpose (e.g. a job photo or an Aadhaar image)', async () => {
      const me = await newUser(t);
      for (const purpose of ['JOB_PHOTO', 'AADHAAR'] as const) {
        const { key } = await uploadFile(t, me.accessToken, purpose);
        await http
          .put(ME, customerPayload(areaId, { photoKey: key }), {
            token: me.accessToken,
          })
          .expect(422);
      }
    });

    it('rejects arbitrary strings and path tricks as keys', async () => {
      const me = await newUser(t);
      for (const photoKey of [
        'hello',
        '../../etc/passwd',
        `u/${me.userId}/PROFILE_PHOTO/../../x.jpg`,
      ]) {
        await http
          .put(ME, customerPayload(areaId, { photoKey }), {
            token: me.accessToken,
          })
          .expect(422);
      }
    });
  });

  describe('GET and PATCH /customers/me', () => {
    it('GET returns 404 PROFILE_NOT_FOUND before onboarding, and the profile after', async () => {
      const me = await newUser(t);
      const missing = await http.get(ME, { token: me.accessToken }).expect(404);
      expect(missing.body.code).toBe('PROFILE_NOT_FOUND');

      await http
        .put(ME, customerPayload(areaId), { token: me.accessToken })
        .expect(200);
      const res = await http.get(ME, { token: me.accessToken }).expect(200);
      expect(res.body.fullName).toBe('Sunita Sharma');
    });

    it('PATCH changes only what was sent', async () => {
      const me = await customer();
      const res = await http
        .patch(ME, { allowDirectCalls: false }, { token: me.accessToken })
        .expect(200);
      expect(res.body).toMatchObject({
        fullName: 'Sunita Sharma',
        commLanguage: 'hi',
        allowDirectCalls: false,
      });
    });

    it('PATCH with photoKey null removes the photo', async () => {
      const me = await newUser(t);
      const { key } = await uploadFile(t, me.accessToken, 'PROFILE_PHOTO');
      await http
        .put(ME, customerPayload(areaId, { photoKey: key }), {
          token: me.accessToken,
        })
        .expect(200);

      const res = await http
        .patch(ME, { photoKey: null }, { token: me.accessToken })
        .expect(200);
      expect(res.body.photoUrl).toBeNull();
    });

    it('PATCH before onboarding is a 404 and creates nothing', async () => {
      const me = await newUser(t);
      const res = await http
        .patch(ME, { fullName: 'Ghost' }, { token: me.accessToken })
        .expect(404);
      expect(res.body.code).toBe('PROFILE_NOT_FOUND');
      expect(await t.prisma.customerProfile.count()).toBe(0);
    });

    it('PATCH rejects invalid and unknown fields', async () => {
      const me = await customer();
      await http
        .patch(ME, { fullName: ' ' }, { token: me.accessToken })
        .expect(422);
      await http
        .patch(ME, { commLanguage: 'xx' }, { token: me.accessToken })
        .expect(422);
      await http
        .patch(ME, { userId: me.userId }, { token: me.accessToken })
        .expect(422);
    });

    it('one account can hold both a customer and a worker profile', async () => {
      const me = await customer();
      await http
        .put(`${V1}/workers/me`, workerPayload(areaId), {
          token: me.accessToken,
        })
        .expect(200);

      const res = await http
        .get(`${V1}/me`, { token: me.accessToken })
        .expect(200);
      expect(res.body.customer).not.toBeNull();
      expect(res.body.worker).toMatchObject({
        fullName: 'Rajesh Kumar',
        verificationStatus: 'PENDING',
      });
    });
  });

  describe('address book', () => {
    const newAddress = (line: string, extra: Record<string, unknown> = {}) => ({
      areaId,
      line,
      ...extra,
    });

    it('needs a customer profile', async () => {
      const me = await newUser(t);
      for (const call of [
        http.get(ADDRESSES, { token: me.accessToken }),
        http.post(ADDRESSES, newAddress('House 9'), { token: me.accessToken }),
      ]) {
        const res = await call.expect(403);
        expect(res.body.code).toBe('CUSTOMER_PROFILE_REQUIRED');
      }
    });

    it('a worker-only account cannot use the customer address book', async () => {
      const me = await newUser(t);
      await http
        .put(`${V1}/workers/me`, workerPayload(areaId), {
          token: me.accessToken,
        })
        .expect(200);
      await http.get(ADDRESSES, { token: me.accessToken }).expect(403);
    });

    it('lists the primary address first', async () => {
      const me = await customer();
      await http
        .post(ADDRESSES, newAddress('Office, Sector 17'), {
          token: me.accessToken,
        })
        .expect(201);
      const res = await http
        .get(ADDRESSES, { token: me.accessToken })
        .expect(200);
      expect(
        res.body.map((a: { line: string; isPrimary: boolean }) => [
          a.line,
          a.isPrimary,
        ]),
      ).toEqual([
        ['House #1402, Near Subhash Park', true],
        ['Office, Sector 17', false],
      ]);
    });

    it('a new address is not primary unless it is the first', async () => {
      const me = await customer();
      const res = await http
        .post(ADDRESSES, newAddress('Parents house'), { token: me.accessToken })
        .expect(201);
      expect(res.body.isPrimary).toBe(false);
    });

    it('allows at most 5 addresses', async () => {
      const me = await customer();
      for (let i = 2; i <= 5; i += 1) {
        await http
          .post(ADDRESSES, newAddress(`Address ${i}`), {
            token: me.accessToken,
          })
          .expect(201);
      }
      const res = await http
        .post(ADDRESSES, newAddress('One too many'), { token: me.accessToken })
        .expect(409);
      expect(res.body.code).toBe('ADDRESS_LIMIT');
      expect(await t.prisma.address.count()).toBe(5);
    });

    it('validates new addresses', async () => {
      const me = await customer();
      await http
        .post(ADDRESSES, newAddress('x'), { token: me.accessToken })
        .expect(422);
      await http
        .post(
          ADDRESSES,
          { areaId: 999999, line: 'House 9' },
          { token: me.accessToken },
        )
        .expect(422);
      await http
        .post(ADDRESSES, newAddress('House 9', { lat: 30 }), {
          token: me.accessToken,
        })
        .expect(422);
      await http
        .post(ADDRESSES, newAddress('House 9', { isPrimary: true }), {
          token: me.accessToken,
        })
        .expect(422);
    });

    it('updates an address, including setting and clearing GPS', async () => {
      const me = await customer();
      const id = me.profile.addresses[0].id;

      const set = await http
        .patch(
          `${ADDRESSES}/${id}`,
          { line: 'New line', lat: 30.7, lng: 76.7 },
          { token: me.accessToken },
        )
        .expect(200);
      expect(set.body).toMatchObject({
        line: 'New line',
        lat: 30.7,
        lng: 76.7,
      });

      const cleared = await http
        .patch(
          `${ADDRESSES}/${id}`,
          { lat: null, lng: null },
          { token: me.accessToken },
        )
        .expect(200);
      expect(cleared.body).toMatchObject({
        lat: null,
        lng: null,
        line: 'New line',
      });

      await http
        .patch(`${ADDRESSES}/${id}`, { lat: 30.7 }, { token: me.accessToken })
        .expect(422);
    });

    it('moves the primary flag, leaving exactly one primary', async () => {
      const me = await customer();
      const second = (
        await http
          .post(ADDRESSES, newAddress('Second'), { token: me.accessToken })
          .expect(201)
      ).body;

      const res = await http
        .post(
          `${ADDRESSES}/${second.id}/primary`,
          {},
          { token: me.accessToken },
        )
        .expect(200);
      expect(res.body).toMatchObject({ id: second.id, isPrimary: true });

      const list = (
        await http.get(ADDRESSES, { token: me.accessToken }).expect(200)
      ).body;
      expect(
        list.filter((a: { isPrimary: boolean }) => a.isPrimary),
      ).toHaveLength(1);
      expect(list[0].id).toBe(second.id);
    });

    it('deleting the primary promotes the oldest remaining address', async () => {
      const me = await customer();
      const original = me.profile.addresses[0].id;
      await http
        .post(ADDRESSES, newAddress('Second'), { token: me.accessToken })
        .expect(201);
      await http
        .post(ADDRESSES, newAddress('Third'), { token: me.accessToken })
        .expect(201);

      await http
        .delete(`${ADDRESSES}/${original}`, { token: me.accessToken })
        .expect(204);

      const list = (
        await http.get(ADDRESSES, { token: me.accessToken }).expect(200)
      ).body;
      expect(
        list.map((a: { line: string; isPrimary: boolean }) => [
          a.line,
          a.isPrimary,
        ]),
      ).toEqual([
        ['Second', true],
        ['Third', false],
      ]);
    });

    it('deleting a non-primary address keeps the primary', async () => {
      const me = await customer();
      const second = (
        await http
          .post(ADDRESSES, newAddress('Second'), { token: me.accessToken })
          .expect(201)
      ).body;
      await http
        .delete(`${ADDRESSES}/${second.id}`, { token: me.accessToken })
        .expect(204);

      const list = (
        await http.get(ADDRESSES, { token: me.accessToken }).expect(200)
      ).body;
      expect(list).toHaveLength(1);
      expect(list[0].isPrimary).toBe(true);
    });

    it("never exposes or touches another customer's addresses (IDOR)", async () => {
      const alice = await customer();
      const bob = await customer();
      const aliceAddress = alice.profile.addresses[0].id;

      // Bob's list contains only Bob's address.
      const bobList = (
        await http.get(ADDRESSES, { token: bob.accessToken }).expect(200)
      ).body;
      expect(bobList.map((a: { id: string }) => a.id)).not.toContain(
        aliceAddress,
      );

      // Every mutation on Alice's id is a plain 404 for Bob and changes nothing.
      await http
        .patch(
          `${ADDRESSES}/${aliceAddress}`,
          { line: 'hacked' },
          { token: bob.accessToken },
        )
        .expect(404);
      await http
        .post(
          `${ADDRESSES}/${aliceAddress}/primary`,
          {},
          { token: bob.accessToken },
        )
        .expect(404);
      await http
        .delete(`${ADDRESSES}/${aliceAddress}`, { token: bob.accessToken })
        .expect(404);

      const intact = await t.prisma.address.findUniqueOrThrow({
        where: { id: aliceAddress },
      });
      expect(intact.line).toBe('House #1402, Near Subhash Park');
      expect(intact.isPrimary).toBe(true);
    });

    it('answers 400 for a malformed id and 404 for an unknown one', async () => {
      const me = await customer();
      await http
        .patch(
          `${ADDRESSES}/not-a-uuid`,
          { line: 'x y z' },
          { token: me.accessToken },
        )
        .expect(400);
      await http
        .delete(`${ADDRESSES}/018f0000-0000-7000-8000-000000000000`, {
          token: me.accessToken,
        })
        .expect(404);
    });
  });
});
