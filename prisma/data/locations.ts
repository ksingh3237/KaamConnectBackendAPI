// Sources: KaamConnect/constants/mockData.ts (TRICITY_SECTORS) and the customer-onboarding
// chips (the 13 base areas), plus the legacy web prototype src/data.js (the 6 `legacy` extras,
// seeded only with SEED_LEGACY_AREAS=true; decision Q-11).
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

export const CITIES: CitySeed[] = [
  {
    name: 'Chandigarh',
    areas: [
      { name: 'Sector 15' },
      { name: 'Sector 17' },
      { name: 'Sector 22' },
      { name: 'Sector 35' },
      { name: 'Sector 43' },
      { name: 'Sector 8', legacy: true },
      { name: 'Manimajra', legacy: true },
    ],
  },
  {
    name: 'Mohali (SAS Nagar)',
    areas: [
      { name: 'Phase 3B2' },
      { name: 'Phase 5' },
      { name: 'Phase 7' },
      { name: 'Sector 70' },
      { name: 'Sector 68', legacy: true },
      { name: 'Kharar Road', legacy: true },
    ],
  },
  {
    name: 'Panchkula',
    areas: [
      { name: 'Sector 5' },
      { name: 'Sector 11' },
      { name: 'Sector 20' },
      { name: 'MDC Sector 4' },
      { name: 'Sector 12', legacy: true },
      { name: 'Sector 15', legacy: true },
    ],
  },
];
