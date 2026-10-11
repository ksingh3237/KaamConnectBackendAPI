import { vi } from 'vitest';
import { OfferStatus } from '../../generated/prisma/enums.js';
import { VISIBLE_TO_CUSTOMER, visibleOfferCounts } from './visible-offers.js';

describe('visibleOfferCounts', () => {
  const build = (grouped: { jobId: string; _count: { _all: number } }[]) => {
    const groupBy = vi.fn().mockResolvedValue(grouped);
    return { prisma: { offer: { groupBy } } as never, groupBy };
  };

  it('asks for nothing at all when there are no jobs', async () => {
    const { prisma, groupBy } = build([]);
    expect((await visibleOfferCounts(prisma, [])).size).toBe(0);
    expect(groupBy).not.toHaveBeenCalled();
  });

  it('makes ONE grouped query, limited to the given jobs and to the customer-visible quotes', async () => {
    const { prisma, groupBy } = build([]);
    await visibleOfferCounts(prisma, ['j1', 'j2']);
    expect(groupBy).toHaveBeenCalledTimes(1);
    expect(groupBy).toHaveBeenCalledWith({
      by: ['jobId'],
      where: { jobId: { in: ['j1', 'j2'] }, ...VISIBLE_TO_CUSTOMER },
      _count: { _all: true },
    });
  });

  it('maps each job to its own count; a job with no visible quote is absent', async () => {
    const { prisma } = build([
      { jobId: 'j1', _count: { _all: 3 } },
      { jobId: 'j3', _count: { _all: 1 } },
    ]);
    const counts = await visibleOfferCounts(prisma, ['j1', 'j2', 'j3']);
    expect(counts.get('j1')).toBe(3);
    expect(counts.get('j3')).toBe(1);
    expect(counts.has('j2')).toBe(false);
  });

  it('uses the one visibility rule: accepted always, pending only for a VERIFIED worker', () => {
    expect(VISIBLE_TO_CUSTOMER.OR).toEqual([
      { status: OfferStatus.ACCEPTED },
      {
        status: OfferStatus.PENDING,
        worker: { verificationStatus: 'VERIFIED' },
      },
    ]);
  });
});
