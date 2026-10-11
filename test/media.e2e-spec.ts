import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { MediaService } from '../src/modules/media/media.service.js';
import { seedReferenceData } from '../prisma/seed/reference-data.js';
import { api, createTestApp, freshIp, type TestApp } from './helpers/app.js';
import { resetDatabase } from './helpers/db.js';
import { TEST_STORAGE_DIR } from './helpers/test-env.js';
import { newUser, uploadFile } from './helpers/personas.js';

const V1 = '/api/v1';
const PRESIGN = `${V1}/media/presign`;

describe('media uploads (e2e, local storage provider)', () => {
  let t: TestApp;
  let http: ReturnType<typeof api>;
  let token: string;
  let userId: string;

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
    const me = await newUser(t);
    token = me.accessToken;
    userId = me.userId;
  });

  const presign = (body: object, opts = { token }) =>
    http.post(PRESIGN, body, opts);
  const photo = {
    purpose: 'PROFILE_PHOTO',
    contentType: 'image/jpeg',
    sizeBytes: 1000,
  };

  describe('POST /media/presign', () => {
    it('returns a signed upload URL and a key namespaced by user and purpose', async () => {
      const res = await presign(photo).expect(200);

      expect(res.body.key).toMatch(
        new RegExp(`^u/${userId}/PROFILE_PHOTO/[0-9a-f-]{36}\\.jpg$`),
      );
      expect(res.body).toMatchObject({
        method: 'PUT',
        expiresInSec: 300,
        headers: { 'Content-Type': 'image/jpeg' },
      });
      expect(res.body.uploadUrl).toContain('/api/v1/dev-storage/media/');
      expect(res.body.uploadUrl).toContain('sig=');
    });

    it('gives each request a new key', async () => {
      const a = await presign(photo).expect(200);
      const b = await presign(photo).expect(200);
      expect(a.body.key).not.toBe(b.body.key);
    });

    it.each([
      ['PROFILE_PHOTO', 'image/jpeg', 'jpg'],
      ['JOB_PHOTO', 'image/png', 'png'],
      ['WORK_PROOF', 'image/webp', 'webp'],
      ['JOB_VOICE', 'audio/mp4', 'm4a'],
      ['JOB_VOICE', 'audio/aac', 'aac'],
      ['JOB_VOICE', 'audio/mpeg', 'mp3'],
    ])('accepts %s as %s', async (purpose, contentType, extension) => {
      const res = await presign({
        purpose,
        contentType,
        sizeBytes: 1000,
      }).expect(200);
      expect(res.body.key.endsWith(`.${extension}`)).toBe(true);
    });

    it('sends Aadhaar images to the separate private bucket', async () => {
      const res = await presign({
        purpose: 'AADHAAR',
        contentType: 'image/jpeg',
        sizeBytes: 1000,
      }).expect(200);
      expect(res.body.uploadUrl).toContain('/dev-storage/private/');
      expect(res.body.uploadUrl).not.toContain('/dev-storage/media/');
    });

    it.each([
      [
        'audio for a photo',
        { purpose: 'PROFILE_PHOTO', contentType: 'audio/mp4', sizeBytes: 1000 },
        'contentType',
      ],
      [
        'an image for a voice note',
        { purpose: 'JOB_VOICE', contentType: 'image/jpeg', sizeBytes: 1000 },
        'contentType',
      ],
      [
        'a GIF',
        { purpose: 'JOB_PHOTO', contentType: 'image/gif', sizeBytes: 1000 },
        'contentType',
      ],
      [
        'an executable',
        {
          purpose: 'JOB_PHOTO',
          contentType: 'application/x-msdownload',
          sizeBytes: 1000,
        },
        'contentType',
      ],
      [
        'a 6 MB photo',
        {
          purpose: 'PROFILE_PHOTO',
          contentType: 'image/jpeg',
          sizeBytes: 6 * 1024 * 1024,
        },
        'sizeBytes',
      ],
      [
        'a 3 MB voice note',
        {
          purpose: 'JOB_VOICE',
          contentType: 'audio/mp4',
          sizeBytes: 3 * 1024 * 1024,
        },
        'sizeBytes',
      ],
      [
        'an empty file',
        { purpose: 'JOB_PHOTO', contentType: 'image/jpeg', sizeBytes: 0 },
        'sizeBytes',
      ],
      [
        'a 50 MB file',
        {
          purpose: 'JOB_PHOTO',
          contentType: 'image/jpeg',
          sizeBytes: 50 * 1024 * 1024,
        },
        'sizeBytes',
      ],
      [
        'an unknown purpose',
        { purpose: 'AVATAR', contentType: 'image/jpeg', sizeBytes: 1000 },
        'purpose',
      ],
      [
        'a fractional size',
        { purpose: 'JOB_PHOTO', contentType: 'image/jpeg', sizeBytes: 10.5 },
        'sizeBytes',
      ],
    ])('rejects %s', async (_label, body, field) => {
      const res = await presign(body).expect(422);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect(res.body.details.map((d: { field: string }) => d.field)).toContain(
        field,
      );
    });

    it('rejects missing fields and unexpected ones', async () => {
      await presign({}).expect(422);
      await presign({ ...photo, bucket: 'private' }).expect(422);
    });

    it('requires login', async () => {
      await http.post(PRESIGN, photo).expect(401);
    });

    it('limits each client IP to 60 presigned URLs per hour', async () => {
      const ip = freshIp();
      for (let i = 0; i < 60; i += 1) {
        await http.post(PRESIGN, photo, { token, ip }).expect(200);
      }
      const blocked = await http
        .post(PRESIGN, photo, { token, ip })
        .expect(429);
      expect(blocked.body.code).toBe('TOO_MANY_REQUESTS');
    });
  });

  describe('using the signed URL (local provider stands in for S3)', () => {
    const put = (
      uploadUrl: string,
      headers: Record<string, string>,
      body: Buffer,
    ) => {
      const url = new URL(uploadUrl);
      return request(t.app.getHttpServer())
        .put(url.pathname + url.search)
        .set(headers)
        .set('X-Forwarded-For', freshIp())
        .send(body);
    };
    const signed = async (sizeBytes = 2048) => {
      const res = await presign({ ...photo, sizeBytes }).expect(200);
      return res.body as {
        uploadUrl: string;
        headers: Record<string, string>;
        key: string;
      };
    };

    it('stores the exact bytes and serves them back through a signed read link', async () => {
      const bytes = Buffer.from(
        Array.from({ length: 2048 }, (_, i) => i % 251),
      );
      const s = await signed(bytes.length);
      await put(s.uploadUrl, s.headers, bytes).expect(200);

      const readUrl = (await t.app
        .get(MediaService)
        .readUrl('PROFILE_PHOTO', s.key))!;
      const url = new URL(readUrl);
      const res = await request(t.app.getHttpServer())
        .get(url.pathname + url.search)
        .set('X-Forwarded-For', freshIp())
        .buffer(true)
        .parse((r, cb) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () => cb(null, Buffer.concat(chunks)));
        })
        .expect(200);

      expect(res.headers['content-type']).toBe('image/jpeg');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['cache-control']).toBe('private, no-store');
      // a web app on another origin (the Expo web dev server) must be allowed to display the picture
      expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
      expect(Buffer.compare(res.body as Buffer, bytes)).toBe(0);
    });

    it('keeps Aadhaar files in the private folder, apart from ordinary media', async () => {
      const aadhaar = await uploadFile(t, token, 'AADHAAR');
      const ordinary = await uploadFile(t, token, 'PROFILE_PHOTO');

      expect(
        existsSync(
          path.join(TEST_STORAGE_DIR, 'private', ...aadhaar.key.split('/')),
        ),
      ).toBe(true);
      expect(
        existsSync(
          path.join(TEST_STORAGE_DIR, 'media', ...aadhaar.key.split('/')),
        ),
      ).toBe(false);
      expect(
        existsSync(
          path.join(TEST_STORAGE_DIR, 'media', ...ordinary.key.split('/')),
        ),
      ).toBe(true);
    });

    it('refuses an upload whose Content-Type differs from what was approved', async () => {
      const s = await signed();
      await put(
        s.uploadUrl,
        { 'Content-Type': 'image/png' },
        Buffer.alloc(2048),
      ).expect(403);
    });

    it('refuses an upload bigger (or smaller) than what was approved', async () => {
      const s = await signed(2048);
      await put(s.uploadUrl, s.headers, Buffer.alloc(4096)).expect(403);
      await put(s.uploadUrl, s.headers, Buffer.alloc(100)).expect(403);
      const file = path.join(TEST_STORAGE_DIR, 'media', ...s.key.split('/'));
      expect(existsSync(file)).toBe(false);
    });

    it('refuses a tampered or missing signature, and a link for a different key', async () => {
      const s = await signed();
      const bad = s.uploadUrl.replace(/sig=[0-9a-f]/, (m) =>
        m.endsWith('0') ? 'sig=1' : 'sig=0',
      );
      await put(bad, s.headers, Buffer.alloc(2048)).expect(403);
      await put(
        s.uploadUrl.replace(/&sig=[0-9a-f]+/, ''),
        s.headers,
        Buffer.alloc(2048),
      ).expect(403);

      const other = await signed();
      const swapped = s.uploadUrl.replace(s.key, other.key);
      await put(swapped, s.headers, Buffer.alloc(2048)).expect(403);
    });

    it('refuses a link whose expiry was pushed into the future', async () => {
      const s = await signed();
      const stretched = s.uploadUrl.replace(
        /exp=(\d+)/,
        (_m, e: string) => `exp=${Number(e) + 100000}`,
      );
      await put(stretched, s.headers, Buffer.alloc(2048)).expect(403);
    });

    it('does not let a path trick reach other files', async () => {
      const server = t.app.getHttpServer();
      const get = (p: string) =>
        request(server).get(p).set('X-Forwarded-For', freshIp());
      await get(`${V1}/dev-storage/media/../../../etc/passwd`).expect(404);
      await get(
        `${V1}/dev-storage/media/u/${userId}/PROFILE_PHOTO/..%2F..%2Fsecret.jpg?exp=9999999999&sig=00`,
      ).expect(404);
      await get(
        `${V1}/dev-storage/media/not-a-key?exp=9999999999&sig=00`,
      ).expect(404);
    });

    it('refuses to download without a valid signature', async () => {
      const uploaded = await uploadFile(t, token, 'PROFILE_PHOTO');
      const server = t.app.getHttpServer();
      const base = `${V1}/dev-storage/media/${uploaded.key}`;
      await request(server)
        .get(base)
        .set('X-Forwarded-For', freshIp())
        .expect(403);
      await request(server)
        .get(`${base}?exp=9999999999&sig=${'0'.repeat(64)}`)
        .set('X-Forwarded-For', freshIp())
        .expect(403);
    });

    it('treats an upload link as a PUT-only capability (cannot be used to download)', async () => {
      const s = await signed();
      await put(s.uploadUrl, s.headers, Buffer.alloc(2048)).expect(200);
      const url = new URL(s.uploadUrl);
      await request(t.app.getHttpServer())
        .get(url.pathname + url.search)
        .set('X-Forwarded-For', freshIp())
        .expect(403);
    });

    it('writes only inside the storage folder', async () => {
      const uploaded = await uploadFile(t, token, 'JOB_PHOTO');
      const stored = path.join(
        TEST_STORAGE_DIR,
        'media',
        ...uploaded.key.split('/'),
      );
      expect(readFileSync(stored).length).toBe(2048);
      expect(stored.startsWith(TEST_STORAGE_DIR)).toBe(true);
    });
  });
});
