import { createHmac, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { API_PREFIX } from '../../../app.setup.js';
import type { EnvVars } from '../../../config/env.validation.js';
import { ANY_KEY_PATTERN, type StorageBucket } from '../media-rules.js';
import { StorageService, type PresignedUpload } from './storage.service.js';

export const DEV_STORAGE_ROUTE = 'dev-storage';

/**
 * DEVELOPMENT ONLY (config validation refuses STORAGE_PROVIDER=local in production).
 * Mimics S3 presigned URLs: URLs point at this API (DevStorageController) and are protected by
 * an HMAC signature and expiry, so a client developer can exercise real uploads with no AWS account.
 */
@Injectable()
export class LocalStorageService extends StorageService {
  readonly rootDir: string;
  private readonly baseUrl: string;
  private readonly secret: Buffer;

  constructor(config: ConfigService<EnvVars, true>) {
    super();
    this.rootDir = path.resolve(
      config.get('STORAGE_LOCAL_DIR', { infer: true }) ?? '.local-storage',
    );
    this.baseUrl =
      config.get('PUBLIC_BASE_URL', { infer: true }) ??
      `http://localhost:${config.get('PORT', { infer: true })}`;
    // Derived, so no extra secret to configure; useless outside this app.
    this.secret = createHmac(
      'sha256',
      config.get('JWT_ACCESS_SECRET', { infer: true }),
    )
      .update('kaamconnect-dev-storage')
      .digest();
  }

  presignUpload(input: {
    bucket: StorageBucket;
    key: string;
    contentType: string;
    sizeBytes: number;
    expiresInSec: number;
  }): Promise<PresignedUpload> {
    const exp = Math.floor(Date.now() / 1000) + input.expiresInSec;
    const sig = this.sign([
      'PUT',
      input.bucket,
      input.key,
      exp,
      input.contentType,
      input.sizeBytes,
    ]);
    const query = new URLSearchParams({
      exp: String(exp),
      ct: input.contentType,
      len: String(input.sizeBytes),
      sig,
    });
    return Promise.resolve({
      url: `${this.baseUrl}/${API_PREFIX}/${DEV_STORAGE_ROUTE}/${input.bucket}/${input.key}?${query}`,
      method: 'PUT',
      headers: { 'Content-Type': input.contentType },
    });
  }

  presignDownload(input: {
    bucket: StorageBucket;
    key: string;
    expiresInSec: number;
  }): Promise<string> {
    const exp = Math.floor(Date.now() / 1000) + input.expiresInSec;
    const sig = this.sign(['GET', input.bucket, input.key, exp]);
    return Promise.resolve(
      `${this.baseUrl}/${API_PREFIX}/${DEV_STORAGE_ROUTE}/${input.bucket}/${input.key}?exp=${exp}&sig=${sig}`,
    );
  }

  async exists(bucket: StorageBucket, key: string): Promise<boolean> {
    try {
      return (await fs.stat(this.filePath(bucket, key))).isFile();
    } catch {
      return false;
    }
  }

  async delete(bucket: StorageBucket, key: string): Promise<void> {
    // filePath() refuses anything that is not one of our own key shapes, so this cannot leave the root
    await fs.rm(this.filePath(bucket, key), { force: true });
  }

  sign(parts: (string | number)[]): string {
    return createHmac('sha256', this.secret)
      .update(parts.join('\n'))
      .digest('hex');
  }

  /** Constant-time signature check plus expiry. */
  verify(parts: (string | number)[], signature: string, exp: number): boolean {
    if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false;
    const expected = Buffer.from(this.sign(parts), 'hex');
    const actual = Buffer.from(signature, 'hex');
    return (
      actual.length === expected.length && timingSafeEqual(actual, expected)
    );
  }

  /** Absolute path for a key, refusing anything that is not one of our own key shapes. */
  filePath(bucket: StorageBucket, key: string): string {
    if (
      (bucket !== 'media' && bucket !== 'private') ||
      !ANY_KEY_PATTERN.test(key)
    ) {
      throw new Error('Invalid storage key');
    }
    const resolved = path.join(this.rootDir, bucket, ...key.split('/'));
    if (!resolved.startsWith(this.rootDir + path.sep))
      throw new Error('Invalid storage key');
    return resolved;
  }
}
