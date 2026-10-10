import path from 'node:path';
import type { ConfigService } from '@nestjs/config';
import type { EnvVars } from '../../../config/env.validation.js';
import { LocalStorageService } from './local-storage.service.js';

function serviceWith(secret = 'a'.repeat(40)) {
  const values: Record<string, unknown> = {
    STORAGE_LOCAL_DIR: path.join(process.cwd(), '.tmp-local-storage-spec'),
    PUBLIC_BASE_URL: 'http://api.test',
    PORT: 3000,
    JWT_ACCESS_SECRET: secret,
  };
  return new LocalStorageService({
    get: (key: string) => values[key],
  } as unknown as ConfigService<EnvVars, true>);
}

const USER = '018f0000-0000-7000-8000-000000000001';
const FILE = '018f0000-0000-4000-8000-000000000002';
const KEY = `u/${USER}/PROFILE_PHOTO/${FILE}.jpg`;
const soon = () => Math.floor(Date.now() / 1000) + 300;

describe('LocalStorageService (development storage)', () => {
  it('verifies a signature it issued and nothing else', () => {
    const s = serviceWith();
    const exp = soon();
    const parts = ['PUT', 'media', KEY, exp, 'image/jpeg', 2048];
    const sig = s.sign(parts);

    expect(s.verify(parts, sig, exp)).toBe(true);
    expect(
      s.verify(['PUT', 'media', KEY, exp, 'image/png', 2048], sig, exp),
    ).toBe(false); // other type
    expect(
      s.verify(['PUT', 'media', KEY, exp, 'image/jpeg', 4096], sig, exp),
    ).toBe(false); // other size
    expect(s.verify(['GET', 'media', KEY, exp], sig, exp)).toBe(false); // other method
    expect(
      s.verify(parts, sig.replace(/^./, sig[0] === 'a' ? 'b' : 'a'), exp),
    ).toBe(false); // tampered
    expect(s.verify(parts, 'not-hex', exp)).toBe(false);
    expect(s.verify(parts, '', exp)).toBe(false);
  });

  it('refuses an expired signature even if it is otherwise correct', () => {
    const s = serviceWith();
    const past = Math.floor(Date.now() / 1000) - 5;
    const parts = ['GET', 'media', KEY, past];
    expect(s.verify(parts, s.sign(parts), past)).toBe(false);
    expect(s.verify(parts, s.sign(parts), Number.NaN)).toBe(false);
  });

  it('signatures from one deployment are useless on another (derived from the JWT secret)', () => {
    const exp = soon();
    const parts = ['GET', 'media', KEY, exp];
    const sig = serviceWith('a'.repeat(40)).sign(parts);
    expect(serviceWith('b'.repeat(40)).verify(parts, sig, exp)).toBe(false);
  });

  it('maps keys to files only inside its root and only for our own key shape', () => {
    const s = serviceWith();
    const file = s.filePath('media', KEY);
    expect(file.startsWith(s.rootDir + path.sep)).toBe(true);
    expect(file).toContain(
      path.join('media', 'u', USER, 'PROFILE_PHOTO', `${FILE}.jpg`),
    );
    expect(s.filePath('private', KEY)).toContain(
      `${path.sep}private${path.sep}`,
    );

    for (const bad of [
      '../../etc/passwd',
      `u/${USER}/PROFILE_PHOTO/../../../x.jpg`,
      `u/${USER}/PROFILE_PHOTO/${FILE}.exe`,
      `/u/${USER}/PROFILE_PHOTO/${FILE}.jpg`,
      `u/${USER}/profile_photo/${FILE}.jpg`,
      '',
    ]) {
      expect(() => s.filePath('media', bad)).toThrow('Invalid storage key');
    }
    expect(() => s.filePath('..' as 'media', KEY)).toThrow(
      'Invalid storage key',
    );
  });

  it('reports a missing file as not existing instead of throwing', async () => {
    expect(await serviceWith().exists('media', KEY)).toBe(false);
    expect(await serviceWith().exists('media', '../escape')).toBe(false);
  });

  it('builds absolute upload URLs under the API prefix', async () => {
    const upload = await serviceWith().presignUpload({
      bucket: 'private',
      key: KEY,
      contentType: 'image/jpeg',
      sizeBytes: 10,
      expiresInSec: 300,
    });
    const url = new URL(upload.url);
    expect(url.origin).toBe('http://api.test');
    expect(url.pathname).toBe(`/api/v1/dev-storage/private/${KEY}`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      ct: 'image/jpeg',
      len: '10',
    });
  });
});
