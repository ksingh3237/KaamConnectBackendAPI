/**
 * The place to show for an address, job or worker base: the locality the person typed when their pocket is not in
 * the sector list ("Sector 82 JLPL"), otherwise the area's own name ("Sector 22").
 */
export function placeName(
  localityName: string | null | undefined,
  areaName: string,
): string {
  const typed = localityName?.trim();
  return typed ? typed : areaName;
}
