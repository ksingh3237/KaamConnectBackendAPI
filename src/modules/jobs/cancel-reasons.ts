import { AppException } from '../../common/exceptions/app.exception.js';
import { JobStatus } from '../../generated/prisma/enums.js';

export type CancelActor = 'CUSTOMER' | 'WORKER';

interface ReasonRule {
  /** What the other person reads ("Your worker cancelled: Vehicle problem"). */
  label: string;
  /** Worker reasons only: the worker's own doing. Feeds the repeat back-out warning and decides whether the visit fee is due. */
  workerFault: boolean;
  /**
   * Worker reasons only, and only for an assigned broadcast job: the request goes back to OPEN for new quotes.
   * When false (the customer or the address is the problem) re-broadcasting the same request would not help.
   */
  reopens: boolean;
}

/** The reasons a worker can give (docs/13-cancellation.md section 3). The app offers the relevant ones for the stage. */
export const WORKER_REASONS = {
  VEHICLE_PROBLEM: {
    label: 'Vehicle problem',
    workerFault: true,
    reopens: true,
  },
  PERSONAL_EMERGENCY: {
    label: 'Personal emergency',
    workerFault: true,
    reopens: true,
  },
  DOUBLE_BOOKED: {
    label: 'Double-booked',
    workerFault: true,
    reopens: true,
  },
  TOO_FAR: {
    label: 'Too far to reach in time',
    workerFault: true,
    reopens: true,
  },
  CANT_DO_WORK: {
    label: 'Cannot do this work',
    workerFault: true,
    reopens: true,
  },
  CUSTOMER_UNREACHABLE: {
    label: 'Customer is not answering',
    workerFault: false,
    reopens: false,
  },
  WRONG_ADDRESS: {
    label: 'Address is wrong or cannot be found',
    workerFault: false,
    reopens: false,
  },
  CUSTOMER_ASKED: {
    label: 'Customer asked me to cancel',
    workerFault: false,
    reopens: false,
  },
  PRICE_DISAGREEMENT: {
    label: 'Could not agree on the price',
    workerFault: false,
    reopens: false,
  },
  UNSAFE_LOCATION: {
    label: 'The location felt unsafe',
    workerFault: false,
    reopens: false,
  },
  OTHER: { label: 'Other reason', workerFault: true, reopens: true },
} as const satisfies Record<string, ReasonRule>;

/** The reasons a customer can give. Customers are never penalised: these are recorded for the worker's information. */
export const CUSTOMER_REASONS = {
  CHANGED_MIND: {
    label: 'Changed my mind',
    workerFault: false,
    reopens: false,
  },
  FOUND_ANOTHER: {
    label: 'Found another worker',
    workerFault: false,
    reopens: false,
  },
  WORKER_LATE: {
    label: 'The worker is taking too long',
    workerFault: false,
    reopens: false,
  },
  WORKER_UNREACHABLE: {
    label: 'Cannot reach the worker',
    workerFault: false,
    reopens: false,
  },
  POSTED_BY_MISTAKE: {
    label: 'Posted by mistake',
    workerFault: false,
    reopens: false,
  },
  PRICE_TOO_HIGH: {
    label: 'The price is too high',
    workerFault: false,
    reopens: false,
  },
  OTHER: { label: 'Other reason', workerFault: false, reopens: false },
} as const satisfies Record<string, ReasonRule>;

/** Every code either side may send: the request body is checked against this before the service runs. */
export const ALL_REASON_CODES: readonly string[] = [
  ...new Set([
    ...Object.keys(WORKER_REASONS),
    ...Object.keys(CUSTOMER_REASONS),
  ]),
];

/** Stored when an older app sends no code at all: a worker with no reason is treated as a plain back-out. */
export const UNSPECIFIED = 'UNSPECIFIED';

/** Worker reliability: this many fault back-outs inside the window earn a warning (and an admin flag). */
export const BACK_OUT_WINDOW_DAYS = 30;
export const BACK_OUT_WARN_AT = 3;

export interface ResolvedReason {
  code: string;
  label: string;
  /** What the person typed, trimmed; null if nothing. */
  note: string | null;
  workerFault: boolean;
  reopens: boolean;
  /** What `jobs.cancel_reason` keeps and the other person sees: their own words, else the label. */
  text: string | null;
}

const invalid = (field: string, issue: string) =>
  new AppException('VALIDATION_FAILED', 422, 'Request validation failed', [
    { field, issue },
  ]);

/**
 * Turns what the caller sent into the rule that applies. `OTHER` needs words; a code that belongs to the
 * other side (a customer sending `VEHICLE_PROBLEM`) is refused. No code at all keeps the behaviour of the
 * first version of the endpoint, so an app that has not been updated still works.
 */
export function resolveReason(
  actor: CancelActor,
  code: string | undefined,
  rawNote: string | undefined,
): ResolvedReason {
  const note = rawNote?.trim() ? rawNote.trim() : null;
  if (!code) {
    return {
      code: UNSPECIFIED,
      label: 'No reason given',
      note,
      workerFault: actor === 'WORKER',
      reopens: actor === 'WORKER',
      text: note ?? (actor === 'WORKER' ? 'BACKED_OUT' : null),
    };
  }
  const table: Record<string, ReasonRule> =
    actor === 'WORKER' ? WORKER_REASONS : CUSTOMER_REASONS;
  const rule = table[code];
  if (!rule)
    throw invalid(
      'reasonCode',
      `not a reason a ${actor === 'WORKER' ? 'worker' : 'customer'} can give`,
    );
  if (code === 'OTHER' && !note)
    throw invalid('reason', 'tell us what happened');
  return {
    code,
    label: rule.label,
    note,
    workerFault: rule.workerFault,
    reopens: rule.reopens,
    text: note ?? rule.label,
  };
}

/** The label for a stored code, for lists; unknown codes (older rows, a newer server) show as the code itself. */
export function labelOfReason(actor: CancelActor, code: string): string {
  const table: Record<string, ReasonRule> =
    actor === 'WORKER' ? WORKER_REASONS : CUSTOMER_REASONS;
  return (
    table[code]?.label ?? (code === UNSPECIFIED ? 'No reason given' : code)
  );
}

/**
 * Whether the worker should be paid the visit fee directly. Only once they have actually arrived, and never when the
 * cancellation is their own doing. The app never moves this money: it only tells both people what is owed.
 */
export function visitFeeIsDue(
  stage: JobStatus,
  actor: CancelActor,
  reason: ResolvedReason,
): boolean {
  if (stage !== JobStatus.ARRIVED) return false;
  return actor === 'CUSTOMER' || !reason.workerFault;
}
