import { generateCode } from './otp.service.js';
import { sha256Hex } from './token.service.js';

describe('generateCode', () => {
  it('always returns exactly 6 digits, keeping leading zeros', () => {
    for (let i = 0; i < 2000; i += 1) {
      expect(generateCode()).toMatch(/^\d{6}$/);
    }
  });

  it('is not constant and spreads over the range', () => {
    const codes = new Set(Array.from({ length: 500 }, generateCode));
    expect(codes.size).toBeGreaterThan(450);
  });
});

describe('sha256Hex', () => {
  it('is deterministic, 64 hex chars, and differs per input', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256Hex('abc')).toHaveLength(64);
    expect(sha256Hex('abd')).not.toBe(sha256Hex('abc'));
  });
});
