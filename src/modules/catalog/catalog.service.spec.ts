import type { PrismaService } from '../../prisma/prisma.service.js';
import { CatalogService } from './catalog.service.js';

function serviceWith(prisma: unknown) {
  return new CatalogService(prisma as PrismaService);
}

describe('CatalogService', () => {
  it('maps a category row to the API shape (titles grouped by language, no internals)', async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        id: 'plumber',
        titleEn: 'Plumber',
        titleHi: 'प्लंबर',
        titlePa: 'ਪਲੰਬਰ',
        iconKey: 'Droplet',
        color: '#0284C7',
        bgColor: '#E0F2FE',
        baseVisitFee: 200,
        examples: 'Pipe Leakage',
        sortOrder: 1,
        isActive: true,
      },
    ]);
    const result = await serviceWith({
      serviceCategory: { findMany },
    }).listServiceCategories();

    expect(result).toEqual([
      {
        id: 'plumber',
        title: { en: 'Plumber', hi: 'प्लंबर', pa: 'ਪਲੰਬਰ' },
        iconKey: 'Droplet',
        color: '#0284C7',
        bgColor: '#E0F2FE',
        baseVisitFee: 200,
        examples: 'Pipe Leakage',
      },
    ]);
  });

  it('asks only for active categories, in display order', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    await serviceWith({
      serviceCategory: { findMany },
    }).listServiceCategories();
    expect(findMany).toHaveBeenCalledWith({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });
  });

  it('selects only id/name for cities and areas, so coordinates never leave the service', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    await serviceWith({ city: { findMany } }).listLocations();
    expect(findMany).toHaveBeenCalledWith({
      orderBy: { id: 'asc' },
      select: {
        id: true,
        name: true,
        areas: { orderBy: { id: 'asc' }, select: { id: true, name: true } },
      },
    });
  });
});
