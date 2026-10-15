import type { PrismaClient } from '../src/generated/prisma/client.js';
import { CITIES } from '../prisma/data/locations.js';
import { SERVICE_CATEGORIES } from '../prisma/data/service-categories.js';
import { seedReferenceData } from '../prisma/seed/reference-data.js';
import { createTestPrisma, resetDatabase } from './helpers/db.js';

describe('reference data seed', () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = createTestPrisma();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  const CATEGORIES = SERVICE_CATEGORIES.length;
  const AREAS = CITIES.flatMap((c) => c.areas).length;

  const counts = async () => ({
    categories: await prisma.serviceCategory.count(),
    cities: await prisma.city.count(),
    areas: await prisma.area.count(),
  });

  it('creates the 20 categories, 3 cities and every Tricity area', async () => {
    expect(CATEGORIES).toBe(20);
    expect(AREAS).toBeGreaterThan(150);
    const report = await seedReferenceData(prisma);
    expect(report.categories).toEqual({ created: CATEGORIES, existing: 0 });
    expect(report.cities).toEqual({ created: 3, existing: 0 });
    expect(report.areas).toMatchObject({ created: AREAS, existing: 0 });
    expect(await counts()).toEqual({
      categories: CATEGORIES,
      cities: 3,
      areas: AREAS,
    });
  });

  it('has no duplicate area within a city, and keeps the original 13 app areas plus the 6 former legacy ones', async () => {
    for (const city of CITIES) {
      const names = city.areas.map((a) => a.name);
      expect(new Set(names).size).toBe(names.length);
    }
    await seedReferenceData(prisma);
    const rows = await prisma.area.findMany({ include: { city: true } });
    const have = new Set(rows.map((r) => `${r.city.name}|${r.name}`));
    for (const [city, names] of [
      [
        'Chandigarh',
        [
          'Sector 15',
          'Sector 17',
          'Sector 22',
          'Sector 35',
          'Sector 43',
          'Sector 8',
          'Manimajra',
        ],
      ],
      [
        'Mohali (SAS Nagar)',
        [
          'Phase 3B2',
          'Phase 5',
          'Phase 7',
          'Sector 70',
          'Sector 68',
          'Kharar Road',
          'Zirakpur',
          'Kharar',
        ],
      ],
      [
        'Panchkula',
        [
          'Sector 5',
          'Sector 11',
          'Sector 20',
          'MDC Sector 4',
          'Sector 12',
          'Sector 15',
        ],
      ],
    ] as const) {
      for (const name of names) expect(have.has(`${city}|${name}`)).toBe(true);
    }
  });

  it('is idempotent: a second run creates nothing and changes no row counts', async () => {
    await seedReferenceData(prisma);
    const second = await seedReferenceData(prisma);
    expect(second.categories).toEqual({ created: 0, existing: CATEGORIES });
    expect(second.cities).toEqual({ created: 0, existing: 3 });
    expect(second.areas).toMatchObject({ created: 0, existing: AREAS });
    expect(await counts()).toEqual({
      categories: CATEGORIES,
      cities: 3,
      areas: AREAS,
    });
  });

  it('needs no legacy flag any more: asking for legacy areas adds nothing', async () => {
    await seedReferenceData(prisma);
    const withLegacy = await seedReferenceData(prisma, {
      includeLegacyAreas: true,
    });
    expect(withLegacy.areas).toMatchObject({ created: 0, existing: AREAS });
    expect((await counts()).areas).toBe(AREAS);
  });

  it('never re-activates a category that was switched off, and never wipes a filled centroid', async () => {
    await seedReferenceData(prisma);
    await prisma.serviceCategory.update({
      where: { id: 'car_wash' },
      data: { isActive: false, baseVisitFee: 1 },
    });
    const area = await prisma.area.findFirstOrThrow({
      where: { name: 'Sector 22' },
    });
    await prisma.area.update({
      where: { id: area.id },
      data: { lat: 30.7333, lng: 76.7794 },
    });

    await seedReferenceData(prisma);

    const carWash = await prisma.serviceCategory.findUniqueOrThrow({
      where: { id: 'car_wash' },
    });
    expect(carWash.isActive).toBe(false); // admin decision survives a re-seed
    expect(carWash.baseVisitFee).toBe(199); // content follows the repository
    const after = await prisma.area.findUniqueOrThrow({
      where: { id: area.id },
    });
    expect([after.lat, after.lng]).toEqual([30.7333, 76.7794]);
  });

  it('seeds the app data faithfully (ids, fees, trilingual titles, order)', async () => {
    await seedReferenceData(prisma);
    const rows = await prisma.serviceCategory.findMany({
      orderBy: { sortOrder: 'asc' },
    });
    expect(rows.map((r) => [r.id, r.baseVisitFee])).toEqual([
      ['electrician', 200],
      ['plumber', 200],
      ['ac_repair', 299],
      ['carpenter', 250],
      ['painter', 300],
      ['cleaner', 299],
      ['appliance', 250],
      ['car_wash', 199],
      ['vehicle_repair', 250],
      ['ro_service', 199],
      ['tv_repair', 250],
      ['fridge_repair', 299],
      ['packers_movers', 499],
      ['glass_works', 250],
      ['generator_service', 350],
      ['gardening', 250],
      ['computer_it', 299],
      ['civil_construction', 350],
      ['catering_food', 400],
      ['cctv_security', 299],
    ]);
    const cleaning = rows.find((r) => r.id === 'cleaner')!;
    expect([cleaning.titleEn, cleaning.titleHi, cleaning.titlePa]).toEqual([
      'Home & Deep Cleaning',
      'घर व डीप सफाई',
      'ਘਰ ਅਤੇ ਡੀਪ ਸਫ਼ਾਈ',
    ]);
    const plumber = rows.find((r) => r.id === 'plumber')!;
    expect([plumber.titleEn, plumber.titleHi, plumber.titlePa]).toEqual([
      'Plumber',
      'प्लंबर / नलसाज',
      'ਪਲੰਬਰ',
    ]);
  });
});
