import { randomInt } from 'node:crypto';

/**
 * The 4-digit code the customer reads out when the worker arrives ("8421"). From the OS CSPRNG,
 * zero-padded so "0042" is as likely as any other. Guessing is limited to 5 tries per job (Phase 5).
 */
/** Five wrong tries lock the code for that assignment (docs/05-security-testing.md "Arrival code"). */
export const MAX_ARRIVAL_ATTEMPTS = 5;
/** A customer may have a new code issued this many times for one assignment... */
export const MAX_ARRIVAL_CODE_RESETS = 3;
/** ...and not more often than this. */
export const ARRIVAL_CODE_RESET_COOLDOWN_SEC = 60;

export const generateArrivalCode = (): string =>
  randomInt(0, 10_000).toString().padStart(4, '0');
