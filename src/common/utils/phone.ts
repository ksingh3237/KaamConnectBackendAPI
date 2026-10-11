/** E.164 Indian mobile: +91 followed by 10 digits starting 6-9 (decision Q-12). */
export const INDIAN_MOBILE_E164 = /^\+91[6-9]\d{9}$/;

/**
 * Normalises what the app sends ("98765 43210", "+91 98765 43210", "98765-43210") to E.164
 * ("+919876543210"). Returns `undefined` when the input is not an Indian mobile number.
 */
export function normalizePhone(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined;
  const compact = input.replace(/[\s\-().]/g, '');
  const local = compact.startsWith('+91') ? compact.slice(3) : compact;
  if (!/^[6-9]\d{9}$/.test(local)) return undefined;
  return `+91${local}`;
}

/** For logs only: "+919876543210" becomes "+9198****3210". */
export function maskPhone(phone: string): string {
  if (phone.length < 8) return '****';
  return `${phone.slice(0, 5)}****${phone.slice(-4)}`;
}
