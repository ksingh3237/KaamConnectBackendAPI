import { describe, expect, it } from 'vitest';
import { violatesConstraint } from './db-errors.js';

describe('violatesConstraint', () => {
  it('finds the constraint name in a message, in metadata, or in a wrapped cause', () => {
    expect(
      violatesConstraint(
        new Error(
          'duplicate key value violates unique constraint "jobs_one_in_progress_per_worker"',
        ),
        'jobs_one_in_progress_per_worker',
      ),
    ).toBe(true);
    expect(
      violatesConstraint(
        {
          meta: {
            driverAdapterError: {
              cause: { message: 'x jobs_one_in_progress_per_worker' },
            },
          },
        },
        'jobs_one_in_progress_per_worker',
      ),
    ).toBe(true);
    expect(
      violatesConstraint(
        {
          message: 'outer',
          cause: {
            cause: { message: 'inner jobs_one_in_progress_per_worker' },
          },
        },
        'jobs_one_in_progress_per_worker',
      ),
    ).toBe(true);
  });

  it('matches an SQLSTATE code only when asked to', () => {
    expect(violatesConstraint({ code: '23505' }, 'x')).toBe(false);
    expect(violatesConstraint({ code: '23505' }, 'x', '23505')).toBe(true);
  });

  it('ignores other errors, missing errors and cycles', () => {
    expect(
      violatesConstraint(new Error('boom'), 'jobs_one_in_progress_per_worker'),
    ).toBe(false);
    expect(violatesConstraint(undefined, 'x')).toBe(false);
    const loop: { cause?: unknown } = {};
    loop.cause = loop;
    expect(violatesConstraint(loop, 'x')).toBe(false);
  });
});
