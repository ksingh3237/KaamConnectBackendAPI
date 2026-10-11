export interface GeoPoint {
  lat: number;
  lng: number;
}

const EARTH_RADIUS_KM = 6371.0088;
const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

/** Great-circle distance in kilometres (haversine). Accurate to well under 1 % at Tricity scale. */
export function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(a.lat)) *
      Math.cos(toRadians(b.lat)) *
      Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** One decimal place, as shown in the app ("0.9 km away"). */
export const roundKm = (km: number): number => Math.round(km * 10) / 10;

/** Straight-line travel time at a constant speed (decision A-11: no routing provider). At least 1 minute. */
export function etaMinutes(distanceKm: number, avgSpeedKmh: number): number {
  return Math.max(1, Math.ceil((distanceKm / avgSpeedKmh) * 60));
}

/** A point only when both coordinates are present; partial or missing data is "no point". */
export function pointOf(
  lat: number | null | undefined,
  lng: number | null | undefined,
): GeoPoint | null {
  return typeof lat === 'number' && typeof lng === 'number'
    ? { lat, lng }
    : null;
}
