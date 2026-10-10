import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { CITIES } from '../data/locations.js';
import { SERVICE_CATEGORIES } from '../data/service-categories.js';

export interface SeedOptions {
  /** Also seed the 6 areas that only exist in the legacy web prototype (decision Q-11). */
  includeLegacyAreas?: boolean;
}

export interface SeedReport {
  categories: { created: number; existing: number };
  cities: { created: number; existing: number };
  areas: { created: number; existing: number; centroidsFilled: number };
}

/**
 * Idempotent, non-destructive reference data (safe in every environment, including production):
 *  - never deletes anything;
 *  - category text/colours/fees follow this repo, but `isActive` is never touched so a category
 *    switched off in the database stays off;
 *  - an area centroid is only filled when missing, never overwritten.
 */
export async function seedReferenceData(
  prisma: PrismaClient,
  options: SeedOptions = {},
): Promise<SeedReport> {
  return prisma.$transaction(async (tx) => {
    const report: SeedReport = {
      categories: { created: 0, existing: 0 },
      cities: { created: 0, existing: 0 },
      areas: { created: 0, existing: 0, centroidsFilled: 0 },
    };

    const knownCategories = new Set(
      (await tx.serviceCategory.findMany({ select: { id: true } })).map(
        (c) => c.id,
      ),
    );
    for (const [sortOrder, category] of SERVICE_CATEGORIES.entries()) {
      const data = { ...category, sortOrder };
      const { id: _id, ...updatable } = data;
      await tx.serviceCategory.upsert({
        where: { id: category.id },
        create: data,
        update: updatable,
      });
      report.categories[
        knownCategories.has(category.id) ? 'existing' : 'created'
      ] += 1;
    }

    for (const city of CITIES) {
      const existingCity = await tx.city.findUnique({
        where: { name: city.name },
      });
      const cityRow =
        existingCity ?? (await tx.city.create({ data: { name: city.name } }));
      report.cities[existingCity ? 'existing' : 'created'] += 1;

      for (const area of city.areas) {
        if (area.legacy && !options.includeLegacyAreas) continue;

        const existing = await tx.area.findUnique({
          where: { cityId_name: { cityId: cityRow.id, name: area.name } },
        });
        if (!existing) {
          await tx.area.create({
            data: {
              cityId: cityRow.id,
              name: area.name,
              lat: area.lat,
              lng: area.lng,
            },
          });
          report.areas.created += 1;
          continue;
        }

        report.areas.existing += 1;
        const missingCentroid = existing.lat === null || existing.lng === null;
        if (
          missingCentroid &&
          area.lat !== undefined &&
          area.lng !== undefined
        ) {
          await tx.area.update({
            where: { id: existing.id },
            data: { lat: area.lat, lng: area.lng },
          });
          report.areas.centroidsFilled += 1;
        }
      }
    }

    return report;
  });
}
