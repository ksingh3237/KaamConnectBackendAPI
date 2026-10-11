import { maskIp, maskPhonesIn, redactSecrets, scrub } from './redact.js';

describe('maskPhonesIn', () => {
  it('masks an E.164 number the same way maskPhone does for stored numbers', () => {
    expect(maskPhonesIn('login for +919876543210 failed')).toBe(
      'login for +9198****3210 failed',
    );
  });

  it('masks the other ways an Indian mobile number gets written', () => {
    for (const written of [
      '9876543210',
      '919876543210',
      '+91 98765 43210'.replace(/ /g, ''),
      '+91-9876543210',
      '09876543210',
    ])
      expect([written, maskPhonesIn(`phone ${written}.`)]).toEqual([
        written,
        'phone +9198****3210.',
      ]);
  });

  it('masks every number in a longer text, including inside JSON and query strings', () => {
    const text =
      '{"phone":"+919876543210","other":"9123456789"} ?phone=9000000001';
    const masked = maskPhonesIn(text);
    expect(masked).not.toMatch(/9876543210|9123456789|9000000001/);
    expect(masked.match(/\+91\d\d\*\*\*\*\d{4}/g)).toHaveLength(3);
  });

  it('leaves things that are not phone numbers alone', () => {
    const untouched = [
      'uuid 0197a0c0-0000-7000-8000-000000000000',
      'epoch 1760162400123', // 13 digits
      'a long id 98765432101234', // more than ten digits in a row
      'amount 550 and 4821 and 100000',
      'starts with five 5876543210', // not 6-9
      'version 1.9876543210', // a decimal
      'KC-10042',
    ];
    for (const text of untouched) expect(maskPhonesIn(text)).toBe(text);
  });
});

describe('redactSecrets', () => {
  it('removes a JWT wherever it appears', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    expect(redactSecrets(`token was ${jwt} ok`)).not.toContain('eyJ');
    expect(redactSecrets(`token was ${jwt} ok`)).toContain('[jwt]');
  });

  it('removes bearer credentials', () => {
    expect(redactSecrets('Authorization: Bearer abc.DEF-123_xyz~+/=')).toBe(
      'Authorization: [redacted]',
    );
    expect(redactSecrets('header Bearer abc123def')).toBe(
      'header Bearer [redacted]',
    );
  });

  it('removes the value of key=value, key: value and JSON secrets but keeps the key', () => {
    expect(redactSecrets('password=hunter2 failed')).toBe(
      'password=[redacted] failed',
    );
    expect(redactSecrets('{"refreshToken":"abc123"}')).toContain('[redacted]');
    expect(redactSecrets('{"password": "hunter2"}')).not.toContain('hunter2');
    expect(redactSecrets('otp: 123456')).toBe('otp: [redacted]');
    expect(redactSecrets('api_key=sk_live_1234')).toBe('api_key=[redacted]');
  });

  it('keeps ordinary error text readable', () => {
    const text =
      'Error: connect ECONNREFUSED 127.0.0.1:5432 at job 0197a0c0 (code P2002)';
    expect(redactSecrets(text)).toBe(text);
  });
});

describe('scrub', () => {
  it('applies both: a failed-query message that echoes a phone number and a token', () => {
    const message =
      'Invalid `prisma.user.create()` invocation: data: { phone: "+919876543210" } token=abc.def.ghi';
    const out = scrub(message);
    expect(out).not.toContain('9876543210');
    expect(out).not.toContain('abc.def.ghi');
    expect(out).toContain('invocation');
  });
});

describe('maskIp', () => {
  it('blanks the last part of an IPv4 address, including the IPv4-mapped form', () => {
    expect(maskIp('203.0.113.77')).toBe('203.0.113.x');
    expect(maskIp('::ffff:203.0.113.77')).toBe('203.0.113.x');
  });

  it('keeps only the first groups of an IPv6 address', () => {
    expect(maskIp('2001:db8:85a3:0:0:8a2e:370:7334')).toBe('2001:db8:85a3::x');
    expect(maskIp('::1')).toBe('1::x');
  });

  it('gives a dash for anything missing or not an address, so nothing attacker-chosen is echoed', () => {
    for (const bad of [undefined, null, '', 'not an ip\nFAKE LOG LINE', '999'])
      expect(maskIp(bad as string | undefined)).toBe('-');
  });
});
