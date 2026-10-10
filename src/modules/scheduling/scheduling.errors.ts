import {
  AppException,
  type ErrorDetail,
} from '../../common/exceptions/app.exception.js';
import type { Availability } from './availability.service.js';

function detailsOf(a: Availability): ErrorDetail[] {
  const details: ErrorDetail[] = [];
  if (a.reason) details.push({ field: 'reason', issue: a.reason });
  if (a.nextFreeAt)
    details.push({ field: 'nextFreeAt', issue: a.nextFreeAt.toISOString() });
  if (a.etaOptions && a.etaOptions.length > 0)
    details.push({ field: 'etaMinutes', issue: a.etaOptions.join(',') });
  return details;
}

/** The worker's own action would double-book them (lead accept, quote, direct accept). */
export const scheduleConflict = (a: Availability) =>
  new AppException(
    'SCHEDULE_CONFLICT',
    409,
    'You already have a booking that clashes with this time',
    detailsOf(a),
  );

/** The customer picked a worker who can no longer make the time (quote accept, direct booking). */
export const workerUnavailable = (a: Availability) =>
  new AppException(
    'WORKER_UNAVAILABLE',
    409,
    'This worker is no longer free at that time',
    detailsOf(a),
  );
