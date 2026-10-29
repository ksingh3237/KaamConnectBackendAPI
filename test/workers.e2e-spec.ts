import request from 'supertest';
import { seedReferenceData } from '../prisma/seed/reference-data.js';
import { api, createTestApp, freshIp, type TestApp } from './helpers/app.js';
import { resetDatabase } from './helpers/db.js';
import {
  anAreaId,
  newUser,
  onboardedWorker,
  uploadFile,
  workerPayload,
} from './helpers/personas.js';

const V1 = '/api/v1';
const ME = `${V1}/workers/me`;

describe('worker profile, documents and location (e2e, MANUAL verification = production behaviour)', () => {
  let t: TestApp;
  let http: ReturnType<typeof api>;
  let areaId: number;

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
    areaId = await anAreaId(t);
  });

  async function worker(overrides: Record<string, unknown> = {}) {
    const me = await newUser(t);
    const res = await http
      .put(ME, workerPayload(areaId, overrides), { token: me.accessToken })
      .expect(200);
    return { ...me, profile: res.body };
  }

  describe('PUT /workers/me (onboarding save)', () => {
    it('creates a PENDING profile with the first trade as primary', async () => {
      const me = await newUser(t);
      const res = await http
        .put(ME, workerPayload(areaId), { token: me.accessToken })
        .expect(200);

      expect(res.body).toMatchObject({
        userId: me.userId,
        fullName: 'Rajesh Kumar',
        photoUrl: null,
        trades: [
          { categoryId: 'electrician', isPrimary: true },
          { categoryId: 'appliance', isPrimary: false },
        ],
        experienceYears: 8,
        skills: ['Wiring', 'MCB Box Repair', 'Fan Repair'],
        languages: ['hi', 'pa'],
        baseArea: { id: areaId, name: 'Sector 15' },
        city: { name: 'Chandigarh' },
        radiusKm: 6,
        visitingFee: null,
        vehicle: null,
        upiId: null,
        badge: null,
        verificationStatus: 'PENDING',
        rejectionReason: null,
        documents: { AADHAAR_FRONT: false, AADHAAR_BACK: false },
        ratingAvg: null,
        reviewCount: 0,
      });
    });

    it('stores the optional extras the app shows but does not yet collect', async () => {
      const me = await newUser(t);
      const res = await http
        .put(
          ME,
          workerPayload(areaId, {
            upiId: 'rajesh@okaxis',
            vehicle: 'Hero Splendor (CH 01 BG 4590)',
            visitingFee: 250,
          }),
          {
            token: me.accessToken,
          },
        )
        .expect(200);
      expect(res.body).toMatchObject({
        upiId: 'rajesh@okaxis',
        vehicle: 'Hero Splendor (CH 01 BG 4590)',
        visitingFee: 250,
      });
    });

    it('cleans the skill chips: trims, drops blanks, removes duplicates ignoring case', async () => {
      const me = await newUser(t);
      const res = await http
        .put(
          ME,
          workerPayload(areaId, {
            skills: [
              '  Wiring ',
              'wiring',
              '',
              '   ',
              'MCB Box Repair',
              'Inverter / Battery',
              'WIRING',
            ],
          }),
          {
            token: me.accessToken,
          },
        )
        .expect(200);
      expect(res.body.skills).toEqual([
        'Wiring',
        'MCB Box Repair',
        'Inverter / Battery',
      ]);
    });

    it('accepts Hindi and Punjabi text in names and skills', async () => {
      const me = await newUser(t);
      const res = await http
        .put(
          ME,
          workerPayload(areaId, {
            fullName: 'रमेश कुमार',
            skills: ['वायरिंग', 'ਪੱਖਾ ਮੁਰੰਮਤ'],
          }),
          { token: me.accessToken },
        )
        .expect(200);
      expect(res.body).toMatchObject({
        fullName: 'रमेश कुमार',
        skills: ['वायरिंग', 'ਪੱਖਾ ਮੁਰੰਮਤ'],
      });
    });

    it('is idempotent and replaces the trade set (reordering changes the primary)', async () => {
      const me = await worker();
      const res = await http
        .put(
          ME,
          workerPayload(areaId, { trades: ['appliance', 'electrician'] }),
          { token: me.accessToken },
        )
        .expect(200);
      expect(res.body.trades).toEqual([
        { categoryId: 'appliance', isPrimary: true },
        { categoryId: 'electrician', isPrimary: false },
      ]);

      const one = await http
        .put(ME, workerPayload(areaId, { trades: ['plumber'] }), {
          token: me.accessToken,
        })
        .expect(200);
      expect(one.body.trades).toEqual([
        { categoryId: 'plumber', isPrimary: true },
      ]);
      expect(await t.prisma.workerProfile.count()).toBe(1);
      expect(await t.prisma.workerTrade.count()).toBe(1);
    });

    it('records when the terms were accepted once, and keeps that moment on later saves', async () => {
      const me = await worker();
      const first = (
        await t.prisma.workerProfile.findUniqueOrThrow({
          where: { userId: me.userId },
        })
      ).termsAcceptedAt;
      await new Promise((resolve) => setTimeout(resolve, 20));
      await http
        .put(ME, workerPayload(areaId, { fullName: 'Rajesh K.' }), {
          token: me.accessToken,
        })
        .expect(200);
      const second = (
        await t.prisma.workerProfile.findUniqueOrThrow({
          where: { userId: me.userId },
        })
      ).termsAcceptedAt;
      expect(second.getTime()).toBe(first.getTime());
    });

    it.each([
      ['no trades', { trades: [] }, 'trades'],
      [
        'three trades',
        { trades: ['electrician', 'plumber', 'carpenter'] },
        'trades',
      ],
      ['a trade twice', { trades: ['plumber', 'plumber'] }, 'trades'],
      ['an unknown trade', { trades: ['astrology'] }, 'trades'],
      ['experience 0', { experienceYears: 0 }, 'experienceYears'],
      ['experience 41', { experienceYears: 41 }, 'experienceYears'],
      ['fractional experience', { experienceYears: 7.5 }, 'experienceYears'],
      ['radius 5 km', { radiusKm: 5 }, 'radiusKm'],
      ['radius as text', { radiusKm: '6 km' }, 'radiusKm'],
      ['no languages', { languages: [] }, 'languages'],
      ['an unsupported language', { languages: ['fr'] }, 'languages'],
      ['a repeated language', { languages: ['hi', 'hi'] }, 'languages'],
      [
        '16 skills',
        { skills: Array.from({ length: 16 }, (_, i) => `Skill ${i}`) },
        'skills',
      ],
      ['a 41-character skill', { skills: ['x'.repeat(41)] }, 'skills'],
      ['a non-text skill', { skills: [42] }, 'skills'],
      ['blank name', { fullName: '  ' }, 'fullName'],
      ['81-character name', { fullName: 'x'.repeat(81) }, 'fullName'],
      ['terms not accepted', { termsAccepted: false }, 'termsAccepted'],
      ['terms missing', { termsAccepted: undefined }, 'termsAccepted'],
      ['malformed UPI id', { upiId: 'rajesh at okaxis' }, 'upiId'],
      ['UPI id without a bank', { upiId: 'rajesh@' }, 'upiId'],
      ['visiting fee 0', { visitingFee: 0 }, 'visitingFee'],
      ['visiting fee 100001', { visitingFee: 100001 }, 'visitingFee'],
      ['81-character vehicle', { vehicle: 'x'.repeat(81) }, 'vehicle'],
      ['missing base area', { baseAreaId: undefined }, 'baseAreaId'],
    ])(
      'rejects %s with a 422 naming the field',
      async (_label, overrides, field) => {
        const me = await newUser(t);
        const res = await http
          .put(ME, workerPayload(areaId, overrides), { token: me.accessToken })
          .expect(422);
        expect(res.body.code).toBe('VALIDATION_FAILED');
        expect(
          res.body.details.map((d: { field: string }) => d.field),
        ).toContain(field);
        expect(await t.prisma.workerProfile.count()).toBe(0);
      },
    );

    it('rejects an unknown area and an inactive category', async () => {
      const me = await newUser(t);
      const unknownArea = await http
        .put(ME, workerPayload(999999), { token: me.accessToken })
        .expect(422);
      expect(unknownArea.body.details).toEqual([
        { field: 'baseAreaId', issue: 'unknown area' },
      ]);

      await t.prisma.serviceCategory.update({
        where: { id: 'plumber' },
        data: { isActive: false },
      });
      const inactive = await http
        .put(ME, workerPayload(areaId, { trades: ['plumber'] }), {
          token: me.accessToken,
        })
        .expect(422);
      expect(inactive.body.details[0].field).toBe('trades');
    });

    it('cannot be used to verify yourself or set protected fields (mass assignment)', async () => {
      const me = await newUser(t);
      const res = await http
        .put(
          ME,
          workerPayload(areaId, {
            verificationStatus: 'VERIFIED',
            badge: 'Govt Certified Pro',
            ratingSum: 500,
            reviewCount: 100,
            userId: '018f0000-0000-7000-8000-000000000000',
          }),
          { token: me.accessToken },
        )
        .expect(422);
      expect(
        res.body.details.map((d: { field: string }) => d.field).sort(),
      ).toEqual([
        'badge',
        'ratingSum',
        'reviewCount',
        'userId',
        'verificationStatus',
      ]);
      expect(await t.prisma.workerProfile.count()).toBe(0);
    });

    it('stays PENDING in manual mode even with both documents', async () => {
      const w = await onboardedWorker(t);
      const res = await http.get(ME, { token: w.accessToken }).expect(200);
      expect(res.body.verificationStatus).toBe('PENDING');
      expect(res.body.documents).toEqual({
        AADHAAR_FRONT: true,
        AADHAAR_BACK: true,
      });
    });

    it('requires login', async () => {
      await http.put(ME, workerPayload(areaId)).expect(401);
    });
  });

  describe('GET and PATCH /workers/me', () => {
    it('GET is 404 PROFILE_NOT_FOUND before onboarding', async () => {
      const me = await newUser(t);
      const res = await http.get(ME, { token: me.accessToken }).expect(404);
      expect(res.body.code).toBe('PROFILE_NOT_FOUND');
    });

    it('PATCH changes only the fields sent', async () => {
      const me = await worker();
      const res = await http
        .patch(
          ME,
          { radiusKm: 12, visitingFee: 300 },
          { token: me.accessToken },
        )
        .expect(200);
      expect(res.body).toMatchObject({
        radiusKm: 12,
        visitingFee: 300,
        fullName: 'Rajesh Kumar',
        experienceYears: 8,
      });
      expect(res.body.trades).toHaveLength(2);
    });

    it('PATCH with null clears optional fields', async () => {
      const me = await worker({
        upiId: 'rajesh@okaxis',
        vehicle: 'Splendor',
        visitingFee: 250,
      });
      const res = await http
        .patch(
          ME,
          { upiId: null, vehicle: null, visitingFee: null, photoKey: null },
          { token: me.accessToken },
        )
        .expect(200);
      expect(res.body).toMatchObject({
        upiId: null,
        vehicle: null,
        visitingFee: null,
        photoUrl: null,
      });
    });

    it('PATCH can replace trades and validates them', async () => {
      const me = await worker();
      const res = await http
        .patch(ME, { trades: ['carpenter'] }, { token: me.accessToken })
        .expect(200);
      expect(res.body.trades).toEqual([
        { categoryId: 'carpenter', isPrimary: true },
      ]);
      await http
        .patch(ME, { trades: ['nope'] }, { token: me.accessToken })
        .expect(422);
      await http
        .patch(ME, { trades: [] }, { token: me.accessToken })
        .expect(422);
    });

    it('PATCH before onboarding is a 404 and creates nothing', async () => {
      const me = await newUser(t);
      await http
        .patch(ME, { radiusKm: 3 }, { token: me.accessToken })
        .expect(404);
      expect(await t.prisma.workerProfile.count()).toBe(0);
    });

    it('PATCH rejects invalid values and protected fields', async () => {
      const me = await worker();
      await http
        .patch(ME, { radiusKm: 7 }, { token: me.accessToken })
        .expect(422);
      await http
        .patch(
          ME,
          { verificationStatus: 'VERIFIED' },
          { token: me.accessToken },
        )
        .expect(422);
      await http
        .patch(ME, { termsAccepted: true }, { token: me.accessToken })
        .expect(422);
      const row = await t.prisma.workerProfile.findUniqueOrThrow({
        where: { userId: me.userId },
      });
      expect(row.verificationStatus).toBe('PENDING');
    });

    it('editing a rejected profile re-submits it for review and clears the reason', async () => {
      const me = await worker();
      await t.prisma.workerProfile.update({
        where: { userId: me.userId },
        data: {
          verificationStatus: 'REJECTED',
          rejectionReason: 'Photo is blurry',
        },
      });
      const seen = await http.get(ME, { token: me.accessToken }).expect(200);
      expect(seen.body).toMatchObject({
        verificationStatus: 'REJECTED',
        rejectionReason: 'Photo is blurry',
      });

      const res = await http
        .patch(
          ME,
          { fullName: 'Rajesh Kumar Sharma' },
          { token: me.accessToken },
        )
        .expect(200);
      expect(res.body).toMatchObject({
        verificationStatus: 'PENDING',
        rejectionReason: null,
      });
    });

    it('does not reopen a VERIFIED profile for ordinary edits', async () => {
      const me = await worker();
      await t.prisma.workerProfile.update({
        where: { userId: me.userId },
        data: { verificationStatus: 'VERIFIED' },
      });
      const res = await http
        .patch(ME, { radiusKm: 3 }, { token: me.accessToken })
        .expect(200);
      expect(res.body.verificationStatus).toBe('VERIFIED');
    });
  });

  describe('profile photo', () => {
    it("accepts the worker's own uploaded photo and rejects an Aadhaar upload used as a photo", async () => {
      const me = await newUser(t);
      const photo = await uploadFile(t, me.accessToken, 'PROFILE_PHOTO');
      const ok = await http
        .put(ME, workerPayload(areaId, { photoKey: photo.key }), {
          token: me.accessToken,
        })
        .expect(200);
      expect(ok.body.photoUrl).toContain('/dev-storage/media/');

      const aadhaar = await uploadFile(t, me.accessToken, 'AADHAAR');
      await http
        .patch(ME, { photoKey: aadhaar.key }, { token: me.accessToken })
        .expect(422);
    });
  });

  describe('PUT /workers/me/documents/:type (Aadhaar front and back)', () => {
    it('needs a worker profile first', async () => {
      const me = await newUser(t);
      const { key } = await uploadFile(t, me.accessToken, 'AADHAAR');
      const res = await http
        .put(
          `${ME}/documents/AADHAAR_FRONT`,
          { key },
          { token: me.accessToken },
        )
        .expect(403);
      expect(res.body.code).toBe('WORKER_PROFILE_REQUIRED');
    });

    it('records each side separately and reports only whether it is present', async () => {
      const me = await worker();
      const front = await uploadFile(t, me.accessToken, 'AADHAAR');
      const one = await http
        .put(
          `${ME}/documents/AADHAAR_FRONT`,
          { key: front.key },
          { token: me.accessToken },
        )
        .expect(200);
      expect(one.body.documents).toEqual({
        AADHAAR_FRONT: true,
        AADHAAR_BACK: false,
      });

      const back = await uploadFile(t, me.accessToken, 'AADHAAR');
      const both = await http
        .put(
          `${ME}/documents/AADHAAR_BACK`,
          { key: back.key },
          { token: me.accessToken },
        )
        .expect(200);
      expect(both.body.documents).toEqual({
        AADHAAR_FRONT: true,
        AADHAAR_BACK: true,
      });
    });

    // The one way to see the picture is GET documents/:type/url below: a short-lived signed link, owner only.
    it('never puts the stored key or an Aadhaar link in a profile response', async () => {
      const w = await onboardedWorker(t);
      const stored = await t.prisma.workerDocument.findMany({
        where: { workerId: w.userId },
      });
      expect(stored).toHaveLength(2);

      const profile = await http.get(ME, { token: w.accessToken }).expect(200);
      const me = await http
        .get(`${V1}/me`, { token: w.accessToken })
        .expect(200);
      for (const body of [
        JSON.stringify(profile.body),
        JSON.stringify(me.body),
      ]) {
        for (const doc of stored) expect(body).not.toContain(doc.storageKey);
        expect(body).not.toContain('AADHAAR/');
        expect(body).not.toContain('/dev-storage/private');
      }
    });

    it('gives the worker a short-lived link to their own document, so the app can show it back', async () => {
      const w = await onboardedWorker(t);
      const res = await http
        .get(`${ME}/documents/AADHAAR_FRONT/url`, { token: w.accessToken })
        .expect(200);

      expect(res.body.expiresInSec).toBe(600);
      expect(res.body.url).toContain('/dev-storage/private/');
      expect(res.body.url).toContain('sig=');

      // and the link really serves the bytes that were uploaded
      const url = new URL(res.body.url);
      await request(t.app.getHttpServer())
        .get(url.pathname + url.search)
        .set('X-Forwarded-For', freshIp())
        .expect(200);
    });

    it('is nobody else’s to read, and 404s for a side that was never uploaded', async () => {
      const w = await worker(); // a worker profile with no documents yet
      await http
        .get(`${ME}/documents/AADHAAR_FRONT/url`, { token: w.accessToken })
        .expect(404);

      const stranger = await newUser(t);
      await http
        .get(`${ME}/documents/AADHAAR_FRONT/url`, { token: stranger.accessToken })
        .expect(403);
    });

    it('replacing a side keeps one row per side', async () => {
      const w = await onboardedWorker(t);
      const fresh = await uploadFile(t, w.accessToken, 'AADHAAR');
      await http
        .put(
          `${ME}/documents/AADHAAR_FRONT`,
          { key: fresh.key },
          { token: w.accessToken },
        )
        .expect(200);

      const rows = await t.prisma.workerDocument.findMany({
        where: { workerId: w.userId, type: 'AADHAAR_FRONT' },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.storageKey).toBe(fresh.key);
    });

    it("rejects keys that are not the worker's own Aadhaar upload", async () => {
      const me = await worker();
      const other = await newUser(t);
      const foreign = await uploadFile(t, other.accessToken, 'AADHAAR');
      const wrongPurpose = await uploadFile(t, me.accessToken, 'PROFILE_PHOTO');
      const neverUploaded = `u/${me.userId}/AADHAAR/00000000-0000-4000-8000-000000000000.jpg`;

      for (const key of [
        foreign.key,
        wrongPurpose.key,
        neverUploaded,
        'nonsense',
        '../etc/passwd',
      ]) {
        const res = await http
          .put(
            `${ME}/documents/AADHAAR_FRONT`,
            { key },
            { token: me.accessToken },
          )
          .expect(422);
        expect(res.body.details[0].field).toBe('key');
      }
      expect(await t.prisma.workerDocument.count()).toBe(0);
    });

    it('rejects an unknown document type and a missing key', async () => {
      const me = await worker();
      const { key } = await uploadFile(t, me.accessToken, 'AADHAAR');
      await http
        .put(`${ME}/documents/PAN_CARD`, { key }, { token: me.accessToken })
        .expect(400);
      await http
        .put(`${ME}/documents/AADHAAR_FRONT`, {}, { token: me.accessToken })
        .expect(422);
    });

    it('sends a VERIFIED or REJECTED profile back to PENDING when evidence is replaced', async () => {
      const w = await onboardedWorker(t);
      for (const status of ['VERIFIED', 'REJECTED'] as const) {
        await t.prisma.workerProfile.update({
          where: { userId: w.userId },
          data: {
            verificationStatus: status,
            verifiedAt: status === 'VERIFIED' ? new Date() : null,
            rejectionReason: status === 'REJECTED' ? 'x' : null,
          },
        });
        const { key } = await uploadFile(t, w.accessToken, 'AADHAAR');
        const res = await http
          .put(
            `${ME}/documents/AADHAAR_BACK`,
            { key },
            { token: w.accessToken },
          )
          .expect(200);
        expect(res.body).toMatchObject({
          verificationStatus: 'PENDING',
          rejectionReason: null,
        });
      }
      const row = await t.prisma.workerProfile.findUniqueOrThrow({
        where: { userId: w.userId },
      });
      expect(row.verifiedAt).toBeNull();
    });
  });

  describe('PUT /workers/me/location (live GPS)', () => {
    const fix = { lat: 30.7333, lng: 76.7794 };

    it('is refused until the worker is verified', async () => {
      const me = await worker();
      const res = await http
        .put(`${ME}/location`, fix, { token: me.accessToken })
        .expect(403);
      expect(res.body.code).toBe('NOT_VERIFIED');
      expect(await t.prisma.workerLocation.count()).toBe(0);
    });

    it('is refused for a user with no worker profile', async () => {
      const me = await newUser(t);
      const res = await http
        .put(`${ME}/location`, fix, { token: me.accessToken })
        .expect(403);
      expect(res.body.code).toBe('WORKER_PROFILE_REQUIRED');
    });

    it('stores the latest fix, drops one that arrives within 3 seconds, then accepts the next', async () => {
      const me = await worker();
      await t.prisma.workerProfile.update({
        where: { userId: me.userId },
        data: { verificationStatus: 'VERIFIED' },
      });

      const first = await http
        .put(`${ME}/location`, fix, { token: me.accessToken })
        .expect(200);
      expect(first.body).toEqual({ accepted: true });

      const tooSoon = await http
        .put(
          `${ME}/location`,
          { lat: 30.8, lng: 76.9 },
          { token: me.accessToken },
        )
        .expect(200);
      expect(tooSoon.body).toEqual({ accepted: false });
      const kept = await t.prisma.workerLocation.findUniqueOrThrow({
        where: { workerId: me.userId },
      });
      expect([kept.lat, kept.lng]).toEqual([fix.lat, fix.lng]);

      await t.prisma
        .$executeRaw`UPDATE worker_locations SET updated_at = now() - interval '10 seconds'`;
      const later = await http
        .put(
          `${ME}/location`,
          { lat: 30.8, lng: 76.9 },
          { token: me.accessToken },
        )
        .expect(200);
      expect(later.body).toEqual({ accepted: true });
      const moved = await t.prisma.workerLocation.findUniqueOrThrow({
        where: { workerId: me.userId },
      });
      expect([moved.lat, moved.lng]).toEqual([30.8, 76.9]);
      expect(await t.prisma.workerLocation.count()).toBe(1);
    });

    it('rejects impossible coordinates and extra fields', async () => {
      const me = await worker();
      await t.prisma.workerProfile.update({
        where: { userId: me.userId },
        data: { verificationStatus: 'VERIFIED' },
      });
      await http
        .put(`${ME}/location`, { lat: 91, lng: 76 }, { token: me.accessToken })
        .expect(422);
      await http
        .put(`${ME}/location`, { lat: 30, lng: 181 }, { token: me.accessToken })
        .expect(422);
      await http
        .put(
          `${ME}/location`,
          { lat: '30.7', lng: 76 },
          { token: me.accessToken },
        )
        .expect(422);
      await http
        .put(
          `${ME}/location`,
          { ...fix, workerId: 'someone-else' },
          { token: me.accessToken },
        )
        .expect(422);
    });

    it("only ever writes the caller's own location", async () => {
      const a = await worker();
      const b = await worker();
      for (const w of [a, b]) {
        await t.prisma.workerProfile.update({
          where: { userId: w.userId },
          data: { verificationStatus: 'VERIFIED' },
        });
      }
      await http
        .put(`${ME}/location`, fix, { token: a.accessToken })
        .expect(200);
      expect(
        await t.prisma.workerLocation.count({ where: { workerId: b.userId } }),
      ).toBe(0);
    });
  });
});

describe('worker verification in AUTO mode (development shortcut)', () => {
  let t: TestApp;
  let http: ReturnType<typeof api>;
  let areaId: number;

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
    areaId = await anAreaId(t);
  });

  it('does not verify a profile that has no documents', async () => {
    const me = await newUser(t);
    const res = await http
      .put(ME, workerPayload(areaId), { token: me.accessToken })
      .expect(200);
    expect(res.body.verificationStatus).toBe('PENDING');
  });

  it('does not verify with only one side uploaded', async () => {
    const me = await newUser(t);
    await http
      .put(ME, workerPayload(areaId), { token: me.accessToken })
      .expect(200);
    const { key } = await uploadFile(t, me.accessToken, 'AADHAAR');
    const res = await http
      .put(`${ME}/documents/AADHAAR_FRONT`, { key }, { token: me.accessToken })
      .expect(200);
    expect(res.body.verificationStatus).toBe('PENDING');
  });

  it('verifies as soon as both sides are in, and stamps the time', async () => {
    const w = await onboardedWorker(t);
    const res = await http.get(ME, { token: w.accessToken }).expect(200);
    expect(res.body.verificationStatus).toBe('VERIFIED');
    const row = await t.prisma.workerProfile.findUniqueOrThrow({
      where: { userId: w.userId },
    });
    expect(row.verifiedAt).not.toBeNull();
  });

  it('re-verifies after a rejected worker fixes their documents', async () => {
    const w = await onboardedWorker(t);
    await t.prisma.workerProfile.update({
      where: { userId: w.userId },
      data: {
        verificationStatus: 'REJECTED',
        verifiedAt: null,
        rejectionReason: 'Back side unreadable',
      },
    });
    const { key } = await uploadFile(t, w.accessToken, 'AADHAAR');
    const res = await http
      .put(`${ME}/documents/AADHAAR_BACK`, { key }, { token: w.accessToken })
      .expect(200);
    expect(res.body).toMatchObject({
      verificationStatus: 'VERIFIED',
      rejectionReason: null,
    });
  });

  it('lets a verified worker send location immediately', async () => {
    const w = await onboardedWorker(t);
    await http
      .put(`${ME}/location`, { lat: 30.7, lng: 76.7 }, { token: w.accessToken })
      .expect(200);
  });
});
