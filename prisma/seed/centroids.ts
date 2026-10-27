import type { PrismaClient } from '../../src/generated/prisma/client.js';
import type { CentroidRow } from '../../src/modules/matching/centroid-csv.js';

export interface CentroidReport {
  /** Areas that had no centroid and got one (or would, in a dry run). */
  filled: string[];
  /** Areas already holding exactly this value. */
  unchanged: number;
  /** Areas that already hold a DIFFERENT centroid: left alone, the same rule as the seed (never overwrite). */
  kept: string[];
  /** Rows naming a city or area the database does not have. */
  unknown: string[];
}

/**
 * Fills missing area centroids from checked rows. A dry run (the default) changes nothing and reports what it would do.
 * An existing centroid is never overwritten: if a value is wrong, fix it by hand so that it is a deliberate act.
 */
export async function applyCentroids(
  prisma: PrismaClient,
  rows: CentroidRow[],
  options: { apply?: boolean } = {},
): Promise<CentroidReport> {
  const report: CentroidReport = {
    filled: [],
    unchanged: 0,
    kept: [],
    unknown: [],
  };
  const run = async (tx: Pick<PrismaClient, 'city' | 'area'>) => {
    for (const row of rows) {
      const label = `${row.city} / ${row.area}`;
      const city = await tx.city.findUnique({ where: { name: row.city } });
      const area = city
        ? await tx.area.findUnique({
            where: { cityId_name: { cityId: city.id, name: row.area } },
          })
        : null;
      if (!area) {
        report.unknown.push(label);
        continue;
      }
      if (area.lat === null || area.lng === null) {
        if (options.apply)
          await tx.area.update({
            where: { id: area.id },
            data: { lat: row.lat, lng: row.lng },
          });
        report.filled.push(label);
      } else if (area.lat === row.lat && area.lng === row.lng) {
        report.unchanged += 1;
      } else {
        report.kept.push(label);
      }
    }
  };
  if (options.apply) await prisma.$transaction(async (tx) => run(tx));
  else await run(prisma);
  return report;
}
