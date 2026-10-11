import { AppException } from '../../../common/exceptions/app.exception.js';
import { JobStatus } from '../../../generated/prisma/enums.js';

export type Actor = 'customer' | 'worker' | 'system';

export type JobAction =
  | 'ACCEPT_OFFER' // customer picks a quote
  | 'ACCEPT_DIRECT' // the requested worker accepts a direct booking
  | 'DECLINE_DIRECT' // the requested worker declines
  | 'EXPIRE' // nobody responded in time
  | 'CUSTOMER_CANCEL'
  | 'WORKER_CANCEL' // assigned worker backs out: broadcast jobs re-open (Q-5)
  | 'WORKER_CANCEL_DIRECT' // ...but a direct booking (D-3) is simply cancelled
  | 'VERIFY_ARRIVAL' // worker enters the customer's 4-digit code
  | 'APPROVE_BILL' // customer approves the inspected cost
  | 'COMPLETE_WORK' // worker finishes
  | 'MARK_PAID'; // customer records cash / UPI payment

interface Transition {
  action: JobAction;
  actor: Actor;
  from: readonly JobStatus[];
  to: JobStatus;
}

const {
  OPEN,
  ASSIGNED,
  ARRIVED,
  IN_PROGRESS,
  WORK_COMPLETED,
  COMPLETED,
  CANCELLED,
} = JobStatus;

/**
 * THE source of truth for what can happen to a job (docs/01-requirements.md section 7).
 * Every service method that changes `jobs.status` goes through `transition()`, and the tests walk
 * this table, so an illegal move can only come from changing this file.
 */
export const TRANSITIONS: readonly Transition[] = [
  { action: 'ACCEPT_OFFER', actor: 'customer', from: [OPEN], to: ASSIGNED },
  { action: 'ACCEPT_DIRECT', actor: 'worker', from: [OPEN], to: ASSIGNED },
  { action: 'DECLINE_DIRECT', actor: 'worker', from: [OPEN], to: CANCELLED },
  { action: 'EXPIRE', actor: 'system', from: [OPEN], to: CANCELLED },
  {
    action: 'CUSTOMER_CANCEL',
    actor: 'customer',
    from: [OPEN, ASSIGNED],
    to: CANCELLED,
  },
  { action: 'WORKER_CANCEL', actor: 'worker', from: [ASSIGNED], to: OPEN },
  {
    action: 'WORKER_CANCEL_DIRECT',
    actor: 'worker',
    from: [ASSIGNED],
    to: CANCELLED,
  },
  { action: 'VERIFY_ARRIVAL', actor: 'worker', from: [ASSIGNED], to: ARRIVED },
  {
    action: 'APPROVE_BILL',
    actor: 'customer',
    from: [ARRIVED],
    to: IN_PROGRESS,
  },
  {
    action: 'COMPLETE_WORK',
    actor: 'worker',
    from: [IN_PROGRESS],
    to: WORK_COMPLETED,
  },
  {
    action: 'MARK_PAID',
    actor: 'customer',
    from: [WORK_COMPLETED],
    to: COMPLETED,
  },
];

const BY_ACTION = new Map(TRANSITIONS.map((t) => [t.action, t]));

export const ACTIVE_STATUSES: readonly JobStatus[] = [
  OPEN,
  ASSIGNED,
  ARRIVED,
  IN_PROGRESS,
  WORK_COMPLETED,
];
export const TERMINAL_STATUSES: readonly JobStatus[] = [COMPLETED, CANCELLED];

export function actorOf(action: JobAction): Actor {
  return BY_ACTION.get(action)!.actor;
}

/** Statuses a job may be in for this action to be allowed (used as the `where` of conditional updates). */
export function allowedFrom(action: JobAction): readonly JobStatus[] {
  return BY_ACTION.get(action)!.from;
}

export function canTransition(action: JobAction, from: JobStatus): boolean {
  return BY_ACTION.get(action)!.from.includes(from);
}

/** The status the job moves to, or `409 INVALID_TRANSITION` if the action is not allowed from `from`. */
export function transition(action: JobAction, from: JobStatus): JobStatus {
  const t = BY_ACTION.get(action)!;
  if (!t.from.includes(from)) {
    throw new AppException(
      'INVALID_TRANSITION',
      409,
      `Cannot ${action} a job that is ${from}`,
    );
  }
  return t.to;
}

/** Which Activity tab a status belongs to. */
export type JobTab = 'ongoing' | 'completed' | 'cancelled';

export function tabOf(status: JobStatus): JobTab {
  if (status === COMPLETED) return 'completed';
  if (status === CANCELLED) return 'cancelled';
  return 'ongoing';
}

export function statusesOfTab(tab: JobTab): JobStatus[] {
  return tab === 'completed'
    ? [COMPLETED]
    : tab === 'cancelled'
      ? [CANCELLED]
      : [...ACTIVE_STATUSES];
}
