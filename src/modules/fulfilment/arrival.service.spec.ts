import { describe, expect, it } from 'vitest';
import { sameCode } from './arrival.service.js';

describe('sameCode', () => {
  it('accepts only the exact code', () => {
    expect(sameCode('8421', '8421')).toBe(true);
    expect(sameCode('8421', '8422')).toBe(false);
    expect(sameCode('8421', '842')).toBe(false);
    expect(sameCode('8421', '84211')).toBe(false);
  });

  it('never accepts anything when the job has no code', () => {
    expect(sameCode(null, '0000')).toBe(false);
    expect(sameCode(null, '')).toBe(false);
  });
});
