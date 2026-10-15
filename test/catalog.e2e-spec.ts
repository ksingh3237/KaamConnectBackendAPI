import { CITIES } from '../prisma/data/locations.js';
import { seedReferenceData } from '../prisma/seed/reference-data.js';
import { api, createTestApp, type TestApp } from './helpers/app.js';
import { loginAs } from './helpers/auth.js';
import { resetDatabase } from './helpers/db.js';
import { nextPhone } from './helpers/factories.js';

const V1 = '/api/v1';

// Real HTTP stack + real PostgreSQL (*_test database). Both endpoints require login.
describe('catalog API (e2e)', () => {
  let t: TestApp;
  let http: ReturnType<typeof api>;
  let token: string;

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
    token = (await loginAs(t, nextPhone())).accessToken;
  });

  it('refuses anonymous callers', async () => {
    await http.get(`${V1}/service-categories`).expect(401);
    await http.get(`${V1}/locations`).expect(401);
  });

  describe('GET /api/v1/service-categories', () => {
    it('returns the 20 categories in display order with titles in all three languages', async () => {
      const res = await http
        .get(`${V1}/service-categories`, { token })
        .expect(200);

      expect(res.body.map((c: { id: string }) => c.id)).toEqual([
        'electrician',
        'plumber',
        'ac_repair',
        'carpenter',
        'painter',
        'cleaner',
        'appliance',
        'car_wash',
        'vehicle_repair',
        'ro_service',
        'tv_repair',
        'fridge_repair',
        'packers_movers',
        'glass_works',
        'generator_service',
        'gardening',
        'computer_it',
        'civil_construction',
        'catering_food',
        'cctv_security',
      ]);
      expect(res.body[1]).toEqual({
        id: 'plumber',
        title: { en: 'Plumber', hi: 'प्लंबर / नलसाज', pa: 'ਪਲੰਬਰ' },
        iconKey: 'Droplet',
        color: '#0284C7',
        bgColor: '#E0F2FE',
        baseVisitFee: 200,
        examples: 'Pipe Leakage, Tap, Geyser, Motor, Tank',
      });
    });

    it('hides inactive categories', async () => {
      await t.prisma.serviceCategory.update({
        where: { id: 'painter' },
        data: { isActive: false },
      });
      const res = await http
        .get(`${V1}/service-categories`, { token })
        .expect(200);
      expect(res.body).toHaveLength(19);
      expect(res.body.map((c: { id: string }) => c.id)).not.toContain(
        'painter',
      );
    });

    it('is cacheable by the client (private), and answers 304 for an unchanged ETag', async () => {
      const first = await http
        .get(`${V1}/service-categories`, { token })
        .expect(200);
      expect(first.headers['cache-control']).toBe('private, max-age=300');
      expect(first.headers.etag).toBeTruthy();

      await http
        .get(`${V1}/service-categories`, { token })
        .set('If-None-Match', first.headers.etag)
        .expect(304);
    });
  });

  describe('GET /api/v1/locations', () => {
    it('returns the three cities with their areas', async () => {
      const res = await http.get(`${V1}/locations`, { token }).expect(200);

      expect(res.body.map((c: { name: string }) => c.name)).toEqual([
        'Chandigarh',
        'Mohali (SAS Nagar)',
        'Panchkula',
      ]);
      const names = (city: string) =>
        res.body
          .find((c: { name: string }) => c.name === city)
          .areas.map((a: { name: string }) => a.name);
      // every city returns its whole seeded list, the original app areas first
      for (const city of CITIES) {
        expect(names(city.name)).toEqual(city.areas.map((a) => a.name));
      }
      expect(names('Chandigarh').slice(0, 5)).toEqual([
        'Sector 15',
        'Sector 17',
        'Sector 22',
        'Sector 35',
        'Sector 43',
      ]);
      expect(names('Mohali (SAS Nagar)')).toEqual(
        expect.arrayContaining(['Phase 7', 'Sector 70', 'Zirakpur', 'Kharar']),
      );
      expect(names('Panchkula')).toEqual(
        expect.arrayContaining(['Sector 11', 'MDC Sector 4']),
      );
    });

    it('exposes only ids and names (no coordinates or internals)', async () => {
      const res = await http.get(`${V1}/locations`, { token }).expect(200);
      expect(Object.keys(res.body[0]).sort()).toEqual(['areas', 'id', 'name']);
      expect(Object.keys(res.body[0].areas[0]).sort()).toEqual(['id', 'name']);
    });
  });
});
