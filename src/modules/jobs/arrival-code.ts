import { randomInt } from 'node:crypto';

/**
 * The 4-digit code the customer reads out when the worker arrives ("8421"). From the OS CSPRNG,
 * zero-padded so "0042" is as likely as any other. Guessing is limited to 5 tries per job (Phase 5).
 */
export const generateArrivalCode = (): string =>
  randomInt(0, 10_000).toString().padStart(4, '0');
