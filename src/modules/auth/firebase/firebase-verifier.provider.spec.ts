import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ConfigService } from '@nestjs/config';
import type { EnvVars } from '../../../config/env.validation.js';
import { AppException } from '../../../common/exceptions/app.exception.js';

vi.mock('firebase-admin/app', () => ({
  cert: vi.fn((c: unknown) => c),
  getApp: vi.fn(() => {
    throw new Error('no app');
  }),
  initializeApp: vi.fn(() => ({ name: 'fake' })),
}));
vi.mock('firebase-admin/auth', () => ({ getAuth: vi.fn() }));

const { firebaseVerifierProvider, DisabledFirebaseVerifier } =
  await import('./firebase-verifier.provider.js');
const { FirebaseAdminVerifier } = await import('./firebase-admin-verifier.js');

type Factory = (c: ConfigService<EnvVars, true>) => unknown;
const build = (settings: Record<string, unknown>) =>
  ((firebaseVerifierProvider as { useFactory: Factory }).useFactory as Factory)(
    { get: (key: string) => settings[key] } as ConfigService<EnvVars, true>,
  );

const JSON_OK = JSON.stringify({
  project_id: 'p',
  client_email: 'svc@p.iam.gserviceaccount.com',
  private_key: 'PRIVATE-KEY-MATERIAL',
});

describe('firebaseVerifierProvider', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'kc-firebase-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('when Firebase sign-in is off, installs a verifier that answers 501 and trusts nothing', async () => {
    const verifier = build({ FIREBASE_AUTH_ENABLED: false });
    expect(verifier).toBeInstanceOf(DisabledFirebaseVerifier);
    const error = (await (verifier as { verify: () => Promise<unknown> })
      .verify()
      .catch((e: unknown) => e)) as AppException;
    expect(error.code).toBe('FIREBASE_AUTH_NOT_CONFIGURED');
    expect(error.getStatus()).toBe(501);
  });

  it('reads credentials from a file path', () => {
    const file = path.join(dir, 'key.json');
    writeFileSync(file, JSON_OK);
    expect(
      build({
        FIREBASE_AUTH_ENABLED: true,
        FIREBASE_SERVICE_ACCOUNT_PATH: file,
      }),
    ).toBeInstanceOf(FirebaseAdminVerifier);
  });

  it('reads credentials from base64 JSON', () => {
    expect(
      build({
        FIREBASE_AUTH_ENABLED: true,
        FIREBASE_SERVICE_ACCOUNT_JSON_BASE64:
          Buffer.from(JSON_OK).toString('base64'),
      }),
    ).toBeInstanceOf(FirebaseAdminVerifier);
  });

  it('fails closed: an unreadable file stops the server from starting', () => {
    expect(() =>
      build({
        FIREBASE_AUTH_ENABLED: true,
        FIREBASE_SERVICE_ACCOUNT_PATH: path.join(dir, 'does-not-exist.json'),
      }),
    ).toThrow(/could not be read/);
  });

  it('fails closed on malformed credentials, and the error never contains the secret', () => {
    const file = path.join(dir, 'bad.json');
    writeFileSync(file, '{"private_key":"PRIVATE-KEY-MATERIAL"');
    try {
      build({
        FIREBASE_AUTH_ENABLED: true,
        FIREBASE_SERVICE_ACCOUNT_PATH: file,
      });
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as Error).message).toMatch(/not valid JSON/);
      expect((error as Error).message).not.toContain('PRIVATE-KEY-MATERIAL');
    }
    expect(() =>
      build({
        FIREBASE_AUTH_ENABLED: true,
        FIREBASE_SERVICE_ACCOUNT_JSON_BASE64:
          Buffer.from('{}').toString('base64'),
      }),
    ).toThrow(/missing "project_id"/);
  });

  it('fails closed when enabled with no credentials at all', () => {
    expect(() => build({ FIREBASE_AUTH_ENABLED: true })).toThrow(
      /no credentials/,
    );
  });
});
