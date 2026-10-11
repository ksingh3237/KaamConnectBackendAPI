import { commissionOn } from './earnings.service.js';

describe('commissionOn (the "commission saved" arithmetic)', () => {
  it('is the benchmark rate of the total, in whole rupees', () => {
    expect(commissionOn(1450, 0.2)).toBe(290);
    expect(commissionOn(0, 0.2)).toBe(0);
  });

  it('rounds to the nearest rupee, half up', () => {
    expect(commissionOn(10, 0.15)).toBe(2); // 1.5
    expect(commissionOn(1449, 0.25)).toBe(362); // 362.25
    expect(commissionOn(1451, 0.25)).toBe(363); // 362.75
  });

  it('a rate of zero saves nothing', () => {
    expect(commissionOn(5000, 0)).toBe(0);
  });
});
