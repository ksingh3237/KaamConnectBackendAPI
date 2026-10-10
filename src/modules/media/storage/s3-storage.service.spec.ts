import type { ConfigService } from '@nestjs/config';
import type { EnvVars } from '../../../config/env.validation.js';
import { S3StorageService } from './s3-storage.service.js';

function serviceWith(overrides: Record<string, string | undefined> = {}) {
  const values: Record<string, string | undefined> = {
    STORAGE_REGION: 'ap-south-1',
    STORAGE_BUCKET: 'kc-media',
    STORAGE_BUCKET_PRIVATE: 'kc-private',
    STORAGE_ACCESS_KEY: 'AKIAEXAMPLEEXAMPLE',
    STORAGE_SECRET_KEY: 'secret-key-for-tests-only-0123456789',
    ...overrides,
  };
  const config = {
    get: (key: string) => values[key],
  } as unknown as ConfigService<EnvVars, true>;
  return new S3StorageService(config);
}

const KEY =
  'u/018f0000-0000-7000-8000-000000000001/PROFILE_PHOTO/018f0000-0000-4000-8000-000000000002.jpg';

describe('S3StorageService presigning (offline: signing needs no network)', () => {
  it('signs a PUT to the media bucket with the content type and size inside the signature', async () => {
    const upload = await serviceWith().presignUpload({
      bucket: 'media',
      key: KEY,
      contentType: 'image/jpeg',
      sizeBytes: 2048,
      expiresInSec: 300,
    });
    const url = new URL(upload.url);

    expect(url.hostname).toBe('kc-media.s3.ap-south-1.amazonaws.com');
    expect(url.pathname).toBe(`/${KEY}`);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);

    // The point of this test: S3 will reject an upload whose type or length differ.
    const signed = (url.searchParams.get('X-Amz-SignedHeaders') ?? '').split(
      ';',
    );
    expect(signed).toEqual(
      expect.arrayContaining(['content-length', 'content-type', 'host']),
    );

    expect(upload.method).toBe('PUT');
    expect(upload.headers).toEqual({ 'Content-Type': 'image/jpeg' });
  });

  it('puts Aadhaar images in the private bucket', async () => {
    const upload = await serviceWith().presignUpload({
      bucket: 'private',
      key: KEY,
      contentType: 'image/jpeg',
      sizeBytes: 100,
      expiresInSec: 300,
    });
    expect(new URL(upload.url).hostname).toBe(
      'kc-private.s3.ap-south-1.amazonaws.com',
    );
  });

  it('signs a time-limited download link', async () => {
    const link = await serviceWith().presignDownload({
      bucket: 'media',
      key: KEY,
      expiresInSec: 600,
    });
    const url = new URL(link);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('600');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
  });

  it('produces different signatures for different sizes (the size is part of what is signed)', async () => {
    const sign = (sizeBytes: number) =>
      serviceWith()
        .presignUpload({
          bucket: 'media',
          key: KEY,
          contentType: 'image/jpeg',
          sizeBytes,
          expiresInSec: 300,
        })
        .then((u) => new URL(u.url).searchParams.get('X-Amz-Signature'));
    expect(await sign(2048)).not.toBe(await sign(4096));
  });

  it('uses path-style URLs for an S3-compatible endpoint such as MinIO', async () => {
    const upload = await serviceWith({
      STORAGE_ENDPOINT: 'http://localhost:9000',
    }).presignUpload({
      bucket: 'media',
      key: KEY,
      contentType: 'image/jpeg',
      sizeBytes: 10,
      expiresInSec: 300,
    });
    const url = new URL(upload.url);
    expect(url.origin).toBe('http://localhost:9000');
    expect(url.pathname).toBe(`/kc-media/${KEY}`);
  });
});
