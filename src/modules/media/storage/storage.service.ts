import type { StorageBucket } from '../media-rules.js';

export interface PresignedUpload {
  url: string;
  method: 'PUT';
  /** The client must send exactly these headers; the signature covers them. */
  headers: Record<string, string>;
}

/**
 * When a download link is signed and for how long. Without a step it is signed now; with one, the signing time is
 * the start of the current step and the lifetime grows by one step, so the link never lives less than `ttlSec`.
 */
export function signingWindow(
  nowMs: number,
  ttlSec: number,
  stepSec?: number,
): { signedAtSec: number; expiresInSec: number } {
  const nowSec = Math.floor(nowMs / 1000);
  if (!stepSec) return { signedAtSec: nowSec, expiresInSec: ttlSec };
  return {
    signedAtSec: Math.floor(nowSec / stepSec) * stepSec,
    expiresInSec: ttlSec + stepSec,
  };
}

/**
 * Object storage behind signed URLs: the API never proxies file bytes.
 * Implementations: S3StorageService (production) and LocalStorageService (development only).
 */
export abstract class StorageService {
  abstract presignUpload(input: {
    bucket: StorageBucket;
    key: string;
    contentType: string;
    sizeBytes: number;
    expiresInSec: number;
  }): Promise<PresignedUpload>;

  /**
   * A GET link. With `stableForSec`, the signing time is rounded down to that step, so every call inside one step
   * returns the SAME link (a screen that polls does not reload its images); the link then stays valid for
   * `expiresInSec` to `expiresInSec + stableForSec` from now.
   */
  abstract presignDownload(input: {
    bucket: StorageBucket;
    key: string;
    expiresInSec: number;
    stableForSec?: number;
  }): Promise<string>;

  abstract exists(bucket: StorageBucket, key: string): Promise<boolean>;

  /**
   * Removes one object. Deleting an object that is already gone is a success, so a retry after a crash
   * finishes the job (account deletion and the Aadhaar retention sweep rely on this). Any other failure throws.
   */
  abstract delete(bucket: StorageBucket, key: string): Promise<void>;
}
