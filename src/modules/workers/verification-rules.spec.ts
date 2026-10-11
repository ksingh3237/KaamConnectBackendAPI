import { VerificationStatus } from '../../generated/prisma/enums.js';
import { normalizeName, reviewEffect } from './verification-rules.js';

describe('normalizeName (decision D-8)', () => {
  it('trims, collapses any run of whitespace to one space and ignores case', () => {
    expect(normalizeName('  Rajesh   KUMAR ')).toBe('rajesh kumar');
    expect(normalizeName('Rajesh\t\nKumar')).toBe('rajesh kumar');
    expect(normalizeName('RAJESH KUMAR')).toBe(normalizeName('rajesh kumar'));
  });

  it('keeps different names different, including a changed letter or an added word', () => {
    expect(normalizeName('Rajesh Kumar')).not.toBe(
      normalizeName('Rajesh Kumari'),
    );
    expect(normalizeName('Rajesh Kumar')).not.toBe(
      normalizeName('Rajesh K Kumar'),
    );
    expect(normalizeName('Rajesh Kumar')).not.toBe(
      normalizeName('RajeshKumar'),
    );
  });

  it('works for names that are not Latin script', () => {
    expect(normalizeName('  राजेश   कुमार ')).toBe('राजेश कुमार');
    expect(normalizeName('ਰਾਜੇਸ਼ ਕੁਮਾਰ')).not.toBe(
      normalizeName('ਰਾਜੇਸ਼ ਕੁਮਾਰੀ'),
    );
  });
});

describe('reviewEffect (decisions D-8 and Q-22): what saving a profile does to verification', () => {
  const stored = (
    verificationStatus: VerificationStatus,
    photoKey: string | null = 'photos/u1/a.jpg',
  ) => ({ verificationStatus, fullName: 'Rajesh Kumar', photoKey });
  const verified = stored(VerificationStatus.VERIFIED);
  const BACK_FOR_REVIEW = {
    verificationStatus: VerificationStatus.PENDING,
    rejectionReason: null,
    verifiedAt: null,
  };

  describe('a VERIFIED worker', () => {
    it('stays verified when the same name is sent again, in any case or spacing', () => {
      for (const fullName of [
        'Rajesh Kumar',
        'rajesh kumar',
        '  Rajesh   KUMAR  ',
      ])
        expect(reviewEffect(verified, { fullName })).toEqual({});
    });

    it('goes back for review when the name really changes', () => {
      expect(reviewEffect(verified, { fullName: 'Rakesh Kumar' })).toEqual(
        BACK_FOR_REVIEW,
      );
      expect(
        reviewEffect(verified, { fullName: 'Rajesh Kumar Singh' }),
      ).toEqual(BACK_FOR_REVIEW);
    });

    it('stays verified when no name is sent (a PATCH about something else)', () => {
      expect(reviewEffect(verified, {})).toEqual({});
    });

    it('goes back for review when the photo is a different file', () => {
      expect(reviewEffect(verified, { photoKey: 'photos/u1/b.jpg' })).toEqual(
        BACK_FOR_REVIEW,
      );
    });

    it('goes back for review when a first photo is added to a profile that had none', () => {
      expect(
        reviewEffect(stored(VerificationStatus.VERIFIED, null), {
          photoKey: 'photos/u1/a.jpg',
        }),
      ).toEqual(BACK_FOR_REVIEW);
    });

    it('stays verified when the same photo is sent again, when the photo is left alone, and when it is removed', () => {
      expect(reviewEffect(verified, { photoKey: 'photos/u1/a.jpg' })).toEqual(
        {},
      );
      expect(reviewEffect(verified, { photoKey: undefined })).toEqual({});
      expect(reviewEffect(verified, { photoKey: null })).toEqual({});
    });

    it('goes back for review once whichever of the two changed, and only once', () => {
      expect(
        reviewEffect(verified, {
          fullName: 'Rajesh Kumar',
          photoKey: 'photos/u1/b.jpg',
        }),
      ).toEqual(BACK_FOR_REVIEW);
      expect(
        reviewEffect(verified, {
          fullName: 'Someone Else',
          photoKey: 'photos/u1/a.jpg',
        }),
      ).toEqual(BACK_FOR_REVIEW);
    });
  });

  describe('the other states', () => {
    it('a REJECTED profile goes back for review on any edit, as before, without touching verifiedAt', () => {
      expect(reviewEffect(stored(VerificationStatus.REJECTED), {})).toEqual({
        verificationStatus: VerificationStatus.PENDING,
        rejectionReason: null,
      });
      expect(
        reviewEffect(stored(VerificationStatus.REJECTED), {
          fullName: 'Rajesh Kumar',
        }),
      ).toEqual({
        verificationStatus: VerificationStatus.PENDING,
        rejectionReason: null,
      });
    });

    it('a PENDING profile has nothing to change, whatever is edited', () => {
      const pending = stored(VerificationStatus.PENDING);
      expect(
        reviewEffect(pending, {
          fullName: 'Completely New',
          photoKey: 'photos/u1/z.jpg',
        }),
      ).toEqual({});
    });

    it('a profile that does not exist yet has nothing to change', () => {
      expect(reviewEffect(null, { fullName: 'New Worker' })).toEqual({});
      expect(reviewEffect(undefined, { fullName: 'New Worker' })).toEqual({});
    });
  });
});
