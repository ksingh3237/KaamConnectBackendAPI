// Tricity sectors, phases and localities (Chandigarh, Mohali incl. Zirakpur/Kharar, Panchkula).
// The first entries of each city are the original 13 app areas, kept first so their ids stay low;
// the app sorts the list itself. The 6 former legacy-prototype extras (decision Q-11) are now part
// of the full list, so nothing is flagged `legacy` any more; the flag and SEED_LEGACY_AREAS still work.
//
// `lat`/`lng` are the area centroid, used for distance when no GPS fix exists. They are
// intentionally NOT filled in: they must come from a verified source (someone local or a
// geocoding dataset), not from memory. Set them in this file and re-run the seed; the seed
// only ever fills a missing centroid, it never overwrites one.
export interface AreaSeed {
  name: string;
  lat?: number;
  lng?: number;
  legacy?: true;
}

export interface CitySeed {
  name: string;
  areas: AreaSeed[];
}

/** "Sector <from>" .. "Sector <to>", leaving out numbers that do not exist on the ground. */
function sectors(from: number, to: number, skip: number[] = []): string[] {
  const names: string[] = [];
  for (let n = from; n <= to; n++)
    if (!skip.includes(n)) names.push(`Sector ${n}`);
  return names;
}

/** Keeps the first spelling of each name (the original app areas come first). */
function areas(...groups: string[][]): AreaSeed[] {
  return [...new Set(groups.flat())].map((name) => ({ name }));
}

/**
 * One per city: the area an address or worker base points at when the person typed their own locality
 * (locality_name). Matching only needs the city (centroids are not filled), so this keeps matching correct.
 */
export const OTHER_AREA = 'Other area';

export const CITIES: CitySeed[] = [
  {
    name: 'Chandigarh',
    areas: areas(
      ['Sector 15', 'Sector 17', 'Sector 22', 'Sector 35', 'Sector 43'],
      ['Sector 8', 'Manimajra'],
      // Chandigarh has no Sector 13
      sectors(1, 56, [13]),
      ['Sector 61', 'Sector 63'],
      [
        'IT Park',
        'Industrial Area Phase 1',
        'Industrial Area Phase 2',
        'Dhanas',
        'Maloya',
        'Daria',
        'Mauli Jagran',
        'Ram Darbar',
        'Hallomajra',
        'Kishangarh',
      ],
      // Anchor for a locality the person types themself (the app hides it from the list)
      [OTHER_AREA],
    ),
  },
  {
    name: 'Mohali (SAS Nagar)',
    areas: areas(
      ['Phase 3B2', 'Phase 5', 'Phase 7', 'Sector 70'],
      ['Sector 68', 'Kharar Road'],
      [
        'Phase 1',
        'Phase 2',
        'Phase 3A',
        'Phase 3B1',
        'Phase 4',
        'Phase 6',
        'Phase 8',
        'Phase 9',
        'Phase 10',
        'Phase 11',
        'Industrial Area Mohali',
      ],
      sectors(66, 127),
      [
        'Aerocity',
        'IT City',
        'TDI City',
        'Sunny Enclave',
        'Kharar',
        'Zirakpur',
        'Dhakoli',
        'Baltana',
        'Peer Muchalla',
        'New Chandigarh',
        'Landran',
      ],
      [OTHER_AREA],
    ),
  },
  {
    name: 'Panchkula',
    areas: areas(
      ['Sector 5', 'Sector 11', 'Sector 20', 'MDC Sector 4'],
      ['Sector 12', 'Sector 15'],
      sectors(1, 12),
      ['Sector 12A'],
      sectors(14, 21),
      sectors(23, 28),
      ['Sector 31'],
      [
        'MDC Sector 1',
        'MDC Sector 2',
        'MDC Sector 3',
        'MDC Sector 5',
        'MDC Sector 6',
      ],
      [
        'Industrial Area Phase 1',
        'Industrial Area Phase 2',
        'Pinjore',
        'Kalka',
        'Ramgarh',
      ],
      [OTHER_AREA],
    ),
  },
];
