import { AppException } from '../../../common/exceptions/app.exception.js';
import { JobStatus } from '../../../generated/prisma/enums.js';
import {
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
  TRANSITIONS,
  actorOf,
  allowedFrom,
  canTransition,
  statusesOfTab,
  tabOf,
  transition,
  type JobAction,
} from './job-state-machine.js';

const ALL_STATUSES = Object.values(JobStatus);
const ALL_ACTIONS = TRANSITIONS.map((t) => t.action);

describe('job state machine', () => {
  it('has exactly one rule per action', () => {
    expect(new Set(ALL_ACTIONS).size).toBe(ALL_ACTIONS.length);
  });

  it.each(
    TRANSITIONS.flatMap((t) =>
      t.from.map((from) => [t.action, from, t.to] as const),
    ),
  )('%s moves %s to %s', (action, from, to) => {
    expect(transition(action, from)).toBe(to);
    expect(canTransition(action, from)).toBe(true);
  });

  it('refuses every combination that is not in the table, with 409 INVALID_TRANSITION', () => {
    let refused = 0;
    for (const action of ALL_ACTIONS) {
      for (const status of ALL_STATUSES) {
        if (allowedFrom(action).includes(status)) continue;
        refused += 1;
        expect(canTransition(action, status)).toBe(false);
        try {
          transition(action, status);
          expect.unreachable(`${action} from ${status} should be refused`);
        } catch (error) {
          expect(error).toBeInstanceOf(AppException);
          expect((error as AppException).getStatus()).toBe(409);
          expect((error as AppException).code).toBe('INVALID_TRANSITION');
        }
      }
    }
    expect(refused).toBeGreaterThan(50);
  });

  it('never leaves a finished job: nothing starts from COMPLETED or CANCELLED', () => {
    for (const status of TERMINAL_STATUSES) {
      for (const action of ALL_ACTIONS)
        expect(canTransition(action, status)).toBe(false);
    }
  });

  it('only a customer can pay, approve the bill or accept a quote; only a worker can verify arrival or finish', () => {
    const actors: Record<JobAction, string> = {
      ACCEPT_OFFER: 'customer',
      ACCEPT_DIRECT: 'worker',
      DECLINE_DIRECT: 'worker',
      EXPIRE: 'system',
      CUSTOMER_CANCEL: 'customer',
      WORKER_CANCEL: 'worker',
      WORKER_CANCEL_DIRECT: 'worker',
      VERIFY_ARRIVAL: 'worker',
      APPROVE_BILL: 'customer',
      COMPLETE_WORK: 'worker',
      MARK_PAID: 'customer',
    };
    for (const action of ALL_ACTIONS)
      expect(actorOf(action)).toBe(actors[action]);
  });

  it('follows the happy path in order: OPEN to COMPLETED', () => {
    let status: JobStatus = JobStatus.OPEN;
    for (const action of [
      'ACCEPT_OFFER',
      'VERIFY_ARRIVAL',
      'APPROVE_BILL',
      'COMPLETE_WORK',
      'MARK_PAID',
    ] as const) {
      status = transition(action, status);
    }
    expect(status).toBe(JobStatus.COMPLETED);
  });

  it('cannot skip a step (no paying before the work is done, no arrival before assignment)', () => {
    expect(canTransition('MARK_PAID', JobStatus.IN_PROGRESS)).toBe(false);
    expect(canTransition('VERIFY_ARRIVAL', JobStatus.OPEN)).toBe(false);
    expect(canTransition('COMPLETE_WORK', JobStatus.ARRIVED)).toBe(false);
  });

  it('a customer can cancel before work starts but not after the worker has arrived', () => {
    expect(canTransition('CUSTOMER_CANCEL', JobStatus.OPEN)).toBe(true);
    expect(canTransition('CUSTOMER_CANCEL', JobStatus.ASSIGNED)).toBe(true);
    expect(canTransition('CUSTOMER_CANCEL', JobStatus.ARRIVED)).toBe(false);
  });

  it('a worker backing out re-opens a broadcast job (Q-5) but cancels a direct booking', () => {
    expect(transition('WORKER_CANCEL', JobStatus.ASSIGNED)).toBe(
      JobStatus.OPEN,
    );
    expect(transition('WORKER_CANCEL_DIRECT', JobStatus.ASSIGNED)).toBe(
      JobStatus.CANCELLED,
    );
  });

  it('a worker can only back out before arriving', () => {
    for (const status of [
      JobStatus.ARRIVED,
      JobStatus.IN_PROGRESS,
      JobStatus.WORK_COMPLETED,
    ]) {
      expect(canTransition('WORKER_CANCEL', status)).toBe(false);
      expect(canTransition('WORKER_CANCEL_DIRECT', status)).toBe(false);
    }
  });

  it('every status is either active or terminal, and maps to exactly one Activity tab', () => {
    for (const status of ALL_STATUSES) {
      expect(
        ACTIVE_STATUSES.includes(status) !== TERMINAL_STATUSES.includes(status),
      ).toBe(true);
    }
    expect(tabOf(JobStatus.OPEN)).toBe('ongoing');
    expect(tabOf(JobStatus.WORK_COMPLETED)).toBe('ongoing');
    expect(tabOf(JobStatus.COMPLETED)).toBe('completed');
    expect(tabOf(JobStatus.CANCELLED)).toBe('cancelled');

    const covered = [
      ...statusesOfTab('ongoing'),
      ...statusesOfTab('completed'),
      ...statusesOfTab('cancelled'),
    ];
    expect([...covered].sort()).toEqual([...ALL_STATUSES].sort());
  });
});
