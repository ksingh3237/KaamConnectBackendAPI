/**
 * Area centroids arrive as a CSV (`city,area,lat,lng`) from someone who knows the places or from a geocoding
 * export, never from memory (docs Q-18). This only reads and checks the file; prisma/seed/centroids.ts applies it.
 */
export interface CentroidRow {
  city: string;
  area: string;
  lat: number;
  lng: number;
}

export interface ParsedCentroids {
  rows: CentroidRow[];
  /** One line per problem, with the file line number. A row with a problem is never applied. */
  errors: string[];
}

/** A plausibility box around the Tricity and its neighbours (Kalka to Kharar). It catches swapped or mistyped values, it is not a boundary. */
export const TRICITY_BOX = {
  minLat: 30.5,
  maxLat: 31.0,
  minLng: 76.5,
  maxLng: 77.0,
};

const HEADER = ['city', 'area', 'lat', 'lng'];

/** Splits one CSV line, honouring double quotes ("Mohali (SAS Nagar)" needs none, but spreadsheets add them). */
export function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      cells.push(cell.trim());
      cell = '';
    } else cell += ch;
  }
  cells.push(cell.trim());
  return cells;
}

/** The template: every area with empty lat/lng, ready to be filled in a spreadsheet. */
export function centroidTemplate(
  cities: { name: string; areas: { name: string }[] }[],
): string {
  const quote = (v: string) =>
    /[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  const lines = [HEADER.join(',')];
  for (const city of cities)
    for (const area of city.areas)
      lines.push(`${quote(city.name)},${quote(area.name)},,`);
  return lines.join('\n') + '\n';
}

export function parseCentroidCsv(text: string): ParsedCentroids {
  const rows: CentroidRow[] = [];
  const errors: string[] = [];
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const header = splitCsvLine(lines[0] ?? '').map((h) => h.toLowerCase());
  if (HEADER.some((name, i) => header[i] !== name)) {
    return {
      rows,
      errors: [`line 1: the header must be exactly "${HEADER.join(',')}"`],
    };
  }
  const seen = new Set<string>();
  for (let i = 1; i < lines.length; i += 1) {
    const raw = lines[i] ?? '';
    if (raw.trim() === '') continue;
    const [city = '', area = '', latText = '', lngText = ''] =
      splitCsvLine(raw);
    if (latText === '' && lngText === '') continue; // an unfilled template row
    const at = `line ${i + 1} (${city} / ${area})`;
    if (!city || !area) {
      errors.push(`${at}: city and area are both required`);
      continue;
    }
    if (latText === '' || lngText === '') {
      errors.push(`${at}: give both lat and lng, or neither`);
      continue;
    }
    const lat = Number(latText);
    const lng = Number(lngText);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      errors.push(`${at}: lat and lng must be numbers`);
      continue;
    }
    const { minLat, maxLat, minLng, maxLng } = TRICITY_BOX;
    if (lat < minLat || lat > maxLat || lng < minLng || lng > maxLng) {
      errors.push(
        `${at}: (${lat}, ${lng}) is outside the Tricity area; lat and lng swapped, or a typo?`,
      );
      continue;
    }
    const key = `${city}|${area}`;
    if (seen.has(key)) {
      errors.push(`${at}: listed twice`);
      continue;
    }
    seen.add(key);
    rows.push({ city, area, lat, lng });
  }
  return { rows, errors };
}
