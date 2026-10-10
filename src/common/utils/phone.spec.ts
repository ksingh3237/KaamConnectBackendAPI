import { INDIAN_MOBILE_E164, maskPhone, normalizePhone } from './phone.js';

describe('normalizePhone', () => {
  it.each([
    ['98765 43210', '+919876543210'], // what the app's login field sends
    ['9876543210', '+919876543210'],
    ['+919876543210', '+919876543210'],
    ['+91 98765 43210', '+919876543210'],
    ['+91-98765-43210', '+919876543210'],
    ['(98765) 43210', '+919876543210'],
    ['  98765 43210  ', '+919876543210'],
  ])('normalises %j', (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it.each([
    ['too short', '98765 4321'],
    ['too long', '98765 432101'],
    ['landline-style prefix 5', '5876543210'],
    ['prefix 0', '0876543210'],
    ['wrong country code', '+14155552671'],
    ['letters', '98765abcde'],
    ['empty', ''],
    ['91 without plus (ambiguous)', '919876543210'],
  ])('rejects %s', (_label, input) => {
    expect(normalizePhone(input)).toBeUndefined();
  });

  it('rejects non-strings', () => {
    expect(normalizePhone(9876543210)).toBeUndefined();
    expect(normalizePhone(null)).toBeUndefined();
    expect(normalizePhone(undefined)).toBeUndefined();
    expect(normalizePhone({})).toBeUndefined();
  });

  it('produces values that satisfy the E.164 pattern used by the validator', () => {
    expect(INDIAN_MOBILE_E164.test(normalizePhone('6000000000')!)).toBe(true);
    expect(INDIAN_MOBILE_E164.test('+915000000000')).toBe(false);
  });
});

describe('maskPhone', () => {
  it('keeps only the country code, two digits and the last four', () => {
    expect(maskPhone('+919876543210')).toBe('+9198****3210');
  });

  it('never throws on short input', () => {
    expect(maskPhone('123')).toBe('****');
  });
});
