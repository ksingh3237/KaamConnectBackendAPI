import { AppException } from '../../../common/exceptions/app.exception.js';

// The Admin SDK is replaced: no test ever contacts Google or needs a real credential.
const verifyIdToken = vi.fn();
vi.mock('firebase-admin/app', () => ({
  cert: vi.fn((c: unknown) => c),
  getApp: vi.fn(() => {
    throw new Error('no app');
  }),
  initializeApp: vi.fn(() => ({ name: 'fake' })),
}));
vi.mock('firebase-admin/auth', () => ({
  getAuth: vi.fn(() => ({ verifyIdToken })),
}));

const { FirebaseAdminVerifier, parseServiceAccount } =
  await import('./firebase-admin-verifier.js');

const CREDENTIALS = {
  project_id: 'p',
  client_email: 'svc@p.iam.gserviceaccount.com',
  private_key:
    '-----BEGIN PRIVATE KEY-----\nSECRET-KEY-MATERIAL\n-----END PRIVATE KEY-----\n',
};

describe('parseServiceAccount', () => {
  it('accepts a service-account JSON and keeps only the three fields it needs', () => {
    const parsed = parseServiceAccount(
      JSON.stringify({ ...CREDENTIALS, type: 'service_account', extra: 1 }),
    );
    expect(parsed).toEqual(CREDENTIALS);
  });

  it('rejects malformed JSON without echoing any of the content', () => {
    try {
      parseServiceAccount('{"private_key": "SECRET-KEY-MATERIAL"');
      throw new Error('should have thrown');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toMatch(/not valid JSON/);
      expect(message).not.toContain('SECRET-KEY-MATERIAL');
    }
  });

  it('names a missing field, never a value', () => {
    for (const key of Object.keys(CREDENTIALS)) {
      const broken = { ...CREDENTIALS, [key]: '' };
      expect(() => parseServiceAccount(JSON.stringify(broken))).toThrow(
        new RegExp(`missing "${key}"`),
      );
    }
    expect(() => parseServiceAccount('null')).toThrow(/missing/);
    expect(() => parseServiceAccount('[]')).toThrow(/missing/);
    try {
      parseServiceAccount(JSON.stringify({ ...CREDENTIALS, project_id: '' }));
    } catch (error) {
      expect((error as Error).message).not.toContain('SECRET-KEY-MATERIAL');
    }
  });
});

describe('FirebaseAdminVerifier.verify', () => {
  const verifier = new FirebaseAdminVerifier(CREDENTIALS);
  beforeEach(() => {
    verifyIdToken.mockReset();
  });

  it('returns only the claims sign-in needs', async () => {
    verifyIdToken.mockResolvedValue({
      uid: 'abc',
      phone_number: '+919876543210',
      auth_time: 1760000000,
      firebase: { sign_in_provider: 'phone' },
      email: 'ignored@example.com',
    });
    await expect(verifier.verify('tok')).resolves.toEqual({
      uid: 'abc',
      phoneNumber: '+919876543210',
      signInProvider: 'phone',
      authTimeSec: 1760000000,
    });
    expect(verifyIdToken).toHaveBeenCalledWith('tok', false);
  });

  it.each([
    'auth/argument-error',
    'auth/invalid-id-token',
    'auth/id-token-expired',
    'auth/id-token-revoked',
  ])('maps %s to 401 FIREBASE_TOKEN_INVALID', async (code) => {
    verifyIdToken.mockImplementation(() =>
      Promise.reject(
        Object.assign(new Error('token eyJ.secret.part is bad'), { code }),
      ),
    );
    const error = (await verifier
      .verify('tok')
      .catch((e) => e)) as AppException;
    expect(error).toBeInstanceOf(AppException);
    expect(error.code).toBe('FIREBASE_TOKEN_INVALID');
    expect(error.getStatus()).toBe(401);
    expect(error.message).not.toContain('eyJ');
  });

  it.each([
    ['credential problems', 'app/invalid-credential'],
    ['network problems', 'app/network-error'],
    ['an SDK error without a code', undefined],
  ])('maps %s to 503 (our side, not the person’s)', async (_label, code) => {
    verifyIdToken.mockImplementation(() =>
      Promise.reject(
        Object.assign(new Error('boom eyJ.secret.part'), code ? { code } : {}),
      ),
    );
    const error = (await verifier
      .verify('tok')
      .catch((e) => e)) as AppException;
    expect(error.code).toBe('FIREBASE_UNAVAILABLE');
    expect(error.getStatus()).toBe(503);
    expect(error.message).not.toContain('eyJ');
  });
});
