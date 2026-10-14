import { AppException } from '../../../common/exceptions/app.exception.js';
import type { FirebaseClaims } from './firebase-verifier.js';
import { phoneFromClaims } from './phone-claims.js';

const NOW = Date.parse('2026-10-13T12:00:00Z');
const nowSec = NOW / 1000;
const MAX_AGE = 300;

const good = (over: Partial<FirebaseClaims> = {}): FirebaseClaims => ({
  uid: 'u1',
  phoneNumber: '+919876543210',
  signInProvider: 'phone',
  authTimeSec: nowSec - 10,
  ...over,
});

const refusal = (claims: FirebaseClaims) => {
  try {
    phoneFromClaims(claims, NOW, MAX_AGE);
  } catch (error) {
    expect(error).toBeInstanceOf(AppException);
    const e = error as AppException;
    return { code: e.code, status: e.getStatus() };
  }
  throw new Error('expected a refusal');
};

describe('phoneFromClaims', () => {
  it('returns the number of a recent Indian phone sign-in', () => {
    expect(phoneFromClaims(good(), NOW, MAX_AGE)).toBe('+919876543210');
  });

  it('accepts a sign-in exactly at the edge of the window and refuses one second later', () => {
    expect(
      phoneFromClaims(good({ authTimeSec: nowSec - MAX_AGE }), NOW, MAX_AGE),
    ).toBe('+919876543210');
    expect(refusal(good({ authTimeSec: nowSec - MAX_AGE - 1 }))).toEqual({
      code: 'FIREBASE_TOKEN_STALE',
      status: 401,
    });
  });

  it('tolerates a little clock skew but not a sign-in from the future', () => {
    expect(
      phoneFromClaims(good({ authTimeSec: nowSec + 30 }), NOW, MAX_AGE),
    ).toBe('+919876543210');
    expect(refusal(good({ authTimeSec: nowSec + 3600 }))).toEqual({
      code: 'FIREBASE_TOKEN_INVALID',
      status: 401,
    });
  });

  it('refuses everything that is not a phone sign-in', () => {
    for (const signInProvider of [
      'password',
      'anonymous',
      'custom',
      'google.com',
      '',
      undefined,
    ]) {
      expect(refusal(good({ signInProvider }))).toEqual({
        code: 'FIREBASE_TOKEN_INVALID',
        status: 401,
      });
    }
  });

  it('refuses a missing or empty phone number', () => {
    for (const phoneNumber of [undefined, '']) {
      expect(refusal(good({ phoneNumber })).code).toBe(
        'FIREBASE_TOKEN_INVALID',
      );
    }
  });

  it('refuses numbers that are not Indian mobiles in E.164, with a distinct code', () => {
    for (const phoneNumber of [
      '+14155550123',
      '+911234567890',
      '+91987654321',
      '+9198765432101',
      '919876543210',
      '9876543210',
      '+91 98765 43210',
    ]) {
      expect(refusal(good({ phoneNumber }))).toEqual({
        code: 'PHONE_NOT_SUPPORTED',
        status: 422,
      });
    }
  });

  it('refuses a non-finite sign-in time instead of treating it as fresh', () => {
    expect(refusal(good({ authTimeSec: Number.NaN })).code).toBe(
      'FIREBASE_TOKEN_INVALID',
    );
    expect(
      refusal(good({ authTimeSec: undefined as unknown as number })).code,
    ).toBe('FIREBASE_TOKEN_INVALID');
  });

  it('uses the window it is given', () => {
    const claims = good({ authTimeSec: nowSec - 100 });
    expect(phoneFromClaims(claims, NOW, 120)).toBe('+919876543210');
    expect(() => phoneFromClaims(claims, NOW, 60)).toThrow(AppException);
  });
});
