/**
 * Cleans the skill chips from the onboarding screen: trims, drops blanks and removes duplicates
 * ignoring case ("Fan Repair" and "fan repair" are one skill). The first spelling wins and the
 * order is kept. Non-string entries are left for the validator to reject.
 */
export function normalizeSkills(input: unknown[]): unknown[] {
  const seen = new Set<string>();
  const result: unknown[] = [];
  for (const item of input) {
    if (typeof item !== 'string') {
      result.push(item);
      continue;
    }
    const skill = item.trim();
    if (skill === '') continue;
    const fingerprint = skill.toLocaleLowerCase('en');
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    result.push(skill);
  }
  return result;
}
