import { AppException } from '../../common/exceptions/app.exception.js';
import { chooseProof } from './account-deletion.service.js';

describe('chooseProof (exactly one way to prove the phone number)', () => {
  it('picks the SMS code when only a code is given', () => {
    expect(chooseProof({ code: '123456' })).toEqual({
      kind: 'code',
      code: '123456',
    });
  });

  it('picks the Firebase token when only a token is given', () => {
    expect(chooseProof({ firebaseIdToken: 'tok' })).toEqual({
      kind: 'firebase',
      idToken: 'tok',
    });
  });

  it('refuses neither and refuses both, as a 422 that names the field', () => {
    for (const proof of [
      {},
      { code: undefined, firebaseIdToken: undefined },
      { code: '123456', firebaseIdToken: 'tok' },
    ]) {
      try {
        chooseProof(proof);
        throw new Error('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(AppException);
        const e = error as AppException;
        expect(e.code).toBe('VALIDATION_FAILED');
        expect(e.getStatus()).toBe(422);
        expect(e.details?.[0]?.issue).toMatch(/exactly one/);
      }
    }
  });
});
