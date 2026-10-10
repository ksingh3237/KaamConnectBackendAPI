import {
  ANY_KEY_PATTERN,
  AUDIO_TYPES,
  IMAGE_TYPES,
  MEDIA_RULES,
  MediaPurpose,
  buildKey,
  ownedKeyPattern,
} from './media-rules.js';

const USER = '018f0000-0000-7000-8000-000000000001';
const OTHER = '018f0000-0000-7000-8000-000000000009';

describe('media rules', () => {
  it('has a rule for every purpose, with Aadhaar alone in the private bucket', () => {
    for (const purpose of Object.values(MediaPurpose)) {
      expect(MEDIA_RULES[purpose]).toBeDefined();
    }
    const privatePurposes = Object.values(MediaPurpose).filter(
      (p) => MEDIA_RULES[p].bucket === 'private',
    );
    expect(privatePurposes).toEqual(['AADHAAR']);
  });

  it('allows images up to 5 MB and voice notes (audio only) up to 2 MB', () => {
    expect(MEDIA_RULES.PROFILE_PHOTO).toMatchObject({
      allowedTypes: IMAGE_TYPES,
      maxBytes: 5 * 1024 * 1024,
    });
    expect(MEDIA_RULES.JOB_VOICE).toMatchObject({
      allowedTypes: AUDIO_TYPES,
      maxBytes: 2 * 1024 * 1024,
    });
  });

  it.each([
    ['image/jpeg', 'jpg'],
    ['image/png', 'png'],
    ['image/webp', 'webp'],
    ['audio/mp4', 'm4a'],
    ['audio/aac', 'aac'],
    ['audio/mpeg', 'mp3'],
  ])(
    'builds a unique key with the right extension for %s',
    (type, extension) => {
      const a = buildKey(USER, 'JOB_PHOTO', type);
      const b = buildKey(USER, 'JOB_PHOTO', type);
      expect(a).toMatch(
        new RegExp(`^u/${USER}/JOB_PHOTO/[0-9a-f-]{36}\\.${extension}$`),
      );
      expect(a).not.toBe(b);
      expect(ANY_KEY_PATTERN.test(a)).toBe(true);
    },
  );

  it('only recognises a key as "owned" for the same user and the same purpose', () => {
    const key = buildKey(USER, 'PROFILE_PHOTO', 'image/jpeg');
    expect(ownedKeyPattern(USER, 'PROFILE_PHOTO').test(key)).toBe(true);
    expect(ownedKeyPattern(OTHER, 'PROFILE_PHOTO').test(key)).toBe(false); // someone else's
    expect(ownedKeyPattern(USER, 'AADHAAR').test(key)).toBe(false); // wrong purpose
    expect(ownedKeyPattern(USER, 'PROFILE_PHOTO').test(`${key}/../x`)).toBe(
      false,
    );
    expect(ownedKeyPattern(USER, 'PROFILE_PHOTO').test(`x${key}`)).toBe(false);
  });
});
