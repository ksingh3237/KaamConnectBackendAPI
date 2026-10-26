import { JobStatus } from '../../generated/prisma/enums.js';
import { JobsService } from './jobs.service.js';

/**
 * The customer's cancel locks the job row and reads what it REALLY is at that moment, so what it records is true even
 * when another request got in between the customer's screen and their tap. Two requests racing for real cannot be lined
 * up on demand against a real database, so the row lock is stubbed: `locked` is what the job is once the lock is held.
 */
describe('JobsService.cancel (customer) against a job that changed under them', () => {
  function build(
    seen: JobStatus,
    locked: { status: JobStatus; worker_id: string | null } | null,
    visitFee = 0,
  ) {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue(locked ? [locked] : []),
      job: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      offer: { updateMany: vi.fn() },
      billItem: {
        aggregate: vi.fn().mockResolvedValue({ _sum: { amount: visitFee } }),
      },
      jobCancellation: { create: vi.fn() },
    };
    const job = {
      id: 'job-1',
      status: seen,
      customerId: 'customer-1',
      workerId: seen === JobStatus.OPEN ? null : 'worker-1',
      targetWorkerId: null,
      title: 'Kitchen sink',
    };
    const prisma = {
      job: {
        findUnique: vi.fn().mockResolvedValue({
          customerId: 'customer-1',
          workerId: job.workerId,
        }),
        findFirst: vi.fn().mockResolvedValue(job),
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          ...job,
          status: JobStatus.CANCELLED,
        }),
      },
      $transaction: (fn: (t: typeof tx) => unknown) => fn(tx),
    };
    const events = {
      statusChanged: vi.fn(),
      leadClosed: vi.fn(),
      workerFreed: vi.fn(),
      cancelledByCustomer: vi.fn(),
    };
    const views = { forCustomer: vi.fn().mockResolvedValue({ id: 'job-1' }) };
    const service = new JobsService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      events as never,
      views as never,
      {} as never,
      {} as never,
    );
    return { service, tx, events };
  }
  const cancel = (service: JobsService) =>
    service.cancel('customer-1', 'job-1', { reasonCode: 'CHANGED_MIND' });

  it('changes only a job that is in the status it just read, and records that status', async () => {
    const { service, tx } = build(JobStatus.ASSIGNED, {
      status: JobStatus.ASSIGNED,
      worker_id: 'worker-1',
    });
    await cancel(service);
    expect(tx.job.updateMany.mock.calls[0]![0].where).toMatchObject({
      id: 'job-1',
      customerId: 'customer-1',
      status: JobStatus.ASSIGNED,
    });
    expect(tx.jobCancellation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        stage: JobStatus.ASSIGNED,
        workerId: 'worker-1',
        visitFeeDue: null,
      }),
    });
  });

  it('refuses with 409 when the worker arrived after the customer saw "on the way", and writes and tells nobody', async () => {
    // Recording "ASSIGNED, no visit fee" for a worker who had in fact arrived would be wrong: the customer must see
    // the on-site wording and the fee first, so they retry.
    const { service, tx, events } = build(JobStatus.ASSIGNED, {
      status: JobStatus.ARRIVED,
      worker_id: 'worker-1',
    });
    await expect(cancel(service)).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
      status: 409,
    });
    expect(tx.job.updateMany).not.toHaveBeenCalled();
    expect(tx.jobCancellation.create).not.toHaveBeenCalled();
    expect(tx.offer.updateMany).not.toHaveBeenCalled();
    expect(events.statusChanged).not.toHaveBeenCalled();
    expect(events.cancelledByCustomer).not.toHaveBeenCalled();
  });

  it('refuses a job that moved past cancellable, or vanished, in the meantime', async () => {
    for (const locked of [
      { status: JobStatus.IN_PROGRESS, worker_id: 'worker-1' },
      { status: JobStatus.COMPLETED, worker_id: 'worker-1' },
      { status: JobStatus.CANCELLED, worker_id: null },
      null,
    ]) {
      const { service, tx } = build(JobStatus.OPEN, locked);
      await expect(cancel(service)).rejects.toMatchObject({
        code: 'INVALID_TRANSITION',
        status: 409,
      });
      expect(tx.jobCancellation.create).not.toHaveBeenCalled();
    }
  });

  it('still cancels a request a worker was accepted on in the meantime, recorded with the real stage and that worker told', async () => {
    // The customer pressed Cancel on a still-open request at the instant a quote was accepted: they asked to cancel.
    const { service, tx, events } = build(JobStatus.OPEN, {
      status: JobStatus.ASSIGNED,
      worker_id: 'worker-1',
    });
    await cancel(service);
    expect(tx.job.updateMany.mock.calls[0]![0].where.status).toBe(
      JobStatus.ASSIGNED,
    );
    expect(tx.jobCancellation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        stage: JobStatus.ASSIGNED,
        workerId: 'worker-1',
      }),
    });
    expect(events.workerFreed).toHaveBeenCalledWith('worker-1', 'job-1');
    expect(events.leadClosed).not.toHaveBeenCalled();
    expect(events.cancelledByCustomer).toHaveBeenCalledTimes(1);
  });

  it('a customer who was shown the on-site screen can decline, and the visit fee is recorded', async () => {
    const { service, tx } = build(
      JobStatus.ARRIVED,
      { status: JobStatus.ARRIVED, worker_id: 'worker-1' },
      250,
    );
    await cancel(service);
    expect(tx.jobCancellation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        stage: JobStatus.ARRIVED,
        visitFeeDue: 250,
      }),
    });
  });
});
