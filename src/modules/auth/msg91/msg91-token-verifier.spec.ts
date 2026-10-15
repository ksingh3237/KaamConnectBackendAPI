import { ConfigService } from '@nestjs/config';
import type { EnvVars } from '../../../config/env.validation.js';
import {
  Msg91HttpTokenVerifier,
  MSG91_VERIFY_ACCESS_TOKEN_URL,
  phoneFromVerifyResponse,
} from './msg91-token-verifier.js';

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

describe('phoneFromVerifyResponse', () => {
  it('returns the verified number as E.164 from a success answer', () => {
    expect(
      phoneFromVerifyResponse(200, {
        type: 'success',
        message: '919876543210',
      }),
    ).toBe('+919876543210');
  });

  it('accepts a number that arrives as a JSON number or with a leading +', () => {
    expect(
      phoneFromVerifyResponse(200, { type: 'success', message: 919876543210 }),
    ).toBe('+919876543210');
    expect(
      phoneFromVerifyResponse(200, {
        type: 'success',
        message: '+919876543210',
      }),
    ).toBe('+919876543210');
  });

  it('refuses an error answer as an invalid or expired verification', () => {
    expect(
      codeOf(() =>
        phoneFromVerifyResponse(200, {
          type: 'error',
          message: 'token expired',
        }),
      ),
    ).toBe('OTP_INVALID');
    expect(
      codeOf(() => phoneFromVerifyResponse(401, { message: 'nope' })),
    ).toBe('OTP_INVALID');
  });

  it('reports MSG91 being down as unavailable, not as a wrong code', () => {
    expect(codeOf(() => phoneFromVerifyResponse(503, undefined))).toBe(
      'OTP_PROVIDER_UNAVAILABLE',
    );
  });

  it.each([
    ['null body', null],
    ['text body', 'ok'],
    ['success without a number', { type: 'success' }],
    ['success with an empty number', { type: 'success', message: '' }],
    [
      'success with a non-Indian number',
      { type: 'success', message: '14155550123' },
    ],
    [
      'success with a landline-looking Indian number',
      { type: 'success', message: '911234567890' },
    ],
    [
      'success whose message is not a number',
      { type: 'success', message: 'verified' },
    ],
    ['success with an object message', { type: 'success', message: {} }],
  ])('fails closed on %s', (_name, body) => {
    expect(codeOf(() => phoneFromVerifyResponse(200, body))).toBe(
      'OTP_PROVIDER_ERROR',
    );
  });
});

describe('Msg91HttpTokenVerifier', () => {
  const config = (authkey?: string) =>
    ({
      get: () => authkey,
    }) as unknown as ConfigService<EnvVars, true>;
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends the authkey and the token to MSG91 over HTTPS and returns the number', async () => {
    fetchMock.mockResolvedValue({
      status: 200,
      json: () => Promise.resolve({ type: 'success', message: '919876543210' }),
    });
    const verifier = new Msg91HttpTokenVerifier(config('server-authkey'));

    await expect(verifier.verify('the.access.token')).resolves.toBe(
      '+919876543210',
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(MSG91_VERIFY_ACCESS_TOKEN_URL);
    expect(url.startsWith('https://')).toBe(true);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      authkey: 'server-authkey',
      'access-token': 'the.access.token',
    });
  });

  it('maps a network failure or timeout to OTP_PROVIDER_UNAVAILABLE', async () => {
    fetchMock.mockRejectedValue(new Error('socket hang up'));
    const verifier = new Msg91HttpTokenVerifier(config('k'));
    await expect(verifier.verify('t')).rejects.toMatchObject({
      code: 'OTP_PROVIDER_UNAVAILABLE',
    });
  });

  it('treats a non-JSON answer as an unexpected one', async () => {
    fetchMock.mockResolvedValue({
      status: 200,
      json: () => Promise.reject(new SyntaxError('bad json')),
    });
    const verifier = new Msg91HttpTokenVerifier(config('k'));
    await expect(verifier.verify('t')).rejects.toMatchObject({
      code: 'OTP_PROVIDER_ERROR',
    });
  });

  it('never calls MSG91 when no authkey is configured', async () => {
    const verifier = new Msg91HttpTokenVerifier(config(undefined));
    await expect(verifier.verify('t')).rejects.toMatchObject({
      code: 'OTP_PROVIDER_UNAVAILABLE',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
