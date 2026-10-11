/**
 * Masking for anything that is written to a log (docs/04-architecture.md "Logging": mask phones, never log
 * tokens). Logs are kept longer and read by more people than the database, so they get the least data.
 */

/** An Indian mobile number: optional +91 / 91 / 0 prefix, then ten digits starting 6-9, not part of a longer number. */
const PHONE = /(?<![\d.])(?:\+?91[\s-]?|0)?[6-9]\d{9}(?![\d])/g;
const JWT = /\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]*/g;
const BEARER = /\bBearer\s+[\w.~+/=-]+/gi;
/**
 * `password=...`, `"refreshToken":"..."`, `authorization: Bearer ...`: the value is replaced, the key is kept for
 * debugging. The key may carry a prefix or suffix (`accessToken`, `api_key_2`), and a `Bearer ` scheme in front
 * of the value goes with it.
 */
const SECRET_PAIR =
  /(\w*(?:password|passwd|secret|token|authorization|api[_-]?key|otp)\w*)(["']?\s*[:=]\s*["']?)((?:Bearer\s+)?[^\s"',;&]+)/gi;

/** "+919876543210" and "98765 43210" both become "+9198****3210" (same shape as `maskPhone` for stored numbers). */
export function maskPhonesIn(text: string): string {
  return text.replace(PHONE, (match) => {
    const ten = match.replace(/\D/g, '').slice(-10);
    return `+91${ten.slice(0, 2)}****${ten.slice(-4)}`;
  });
}

/** Removes credentials from free text: JWTs, bearer tokens and `key=value` secrets. */
export function redactSecrets(text: string): string {
  return text
    .replace(JWT, '[jwt]')
    .replace(BEARER, 'Bearer [redacted]')
    .replace(
      SECRET_PAIR,
      (_all, key: string, glue: string) => `${key}${glue}[redacted]`,
    );
}

/** Everything the log writers apply to a string. */
export function scrub(text: string): string {
  return maskPhonesIn(redactSecrets(text));
}

/**
 * The client address with its host part blanked: enough to see where traffic comes from, not who it is.
 * IPv4 `203.0.113.77` -> `203.0.113.x`; IPv6 keeps its first three groups; anything else -> `-`.
 */
export function maskIp(ip: string | undefined | null): string {
  if (!ip) return '-';
  const mapped = ip.replace(/^::ffff:/i, '');
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(mapped);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.x`;
  if (/^[0-9a-f:]+$/i.test(ip) && ip.includes(':')) {
    const groups = ip.split(':').filter((g) => g !== '');
    return `${groups.slice(0, 3).join(':')}::x`;
  }
  return '-';
}
