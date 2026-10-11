import type { ConfigService } from '@nestjs/config';
import type { EnvVars } from '../../config/env.validation.js';

/** The three settings that decide how long a request stays open for answers. */
export interface OpenTtlSettings {
  /** Broadcast request with no appointment time. */
  openTtlHours: number;
  /** A direct request to one worker. */
  directTtlMin: number;
  /** A request for an exact time keeps collecting quotes this long, but never past the appointment. */
  scheduledTtlHours: number;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/**
 * When a request stops accepting answers. Used when it is posted and again when a worker backs out and
 * it is re-opened, so both follow the same rule.
 */
export function openUntil(
  now: Date,
  scheduledFor: Date | null,
  direct: boolean,
  ttl: OpenTtlSettings,
): Date {
  if (direct) return new Date(now.getTime() + ttl.directTtlMin * MINUTE_MS);
  if (!scheduledFor)
    return new Date(now.getTime() + ttl.openTtlHours * HOUR_MS);
  const until = Math.min(
    scheduledFor.getTime(),
    now.getTime() + ttl.scheduledTtlHours * HOUR_MS,
  );
  // Always long enough for a quote to arrive, even for an appointment minutes away.
  return new Date(Math.max(until, now.getTime() + 10 * MINUTE_MS));
}

/** Reads the three settings from configuration. */
export function readOpenTtl(
  config: ConfigService<EnvVars, true>,
): OpenTtlSettings {
  return {
    openTtlHours: config.get('JOB_OPEN_TTL_HOURS', { infer: true }),
    directTtlMin: config.get('DIRECT_ACCEPT_TTL_MIN', { infer: true }),
    scheduledTtlHours: config.get('SCHEDULED_JOB_OPEN_TTL_HOURS', {
      infer: true,
    }),
  };
}
