import type { StorageBucket } from '../media-rules.js';

export interface PresignedUpload {
  url: string;
  method: 'PUT';
  /** The client must send exactly these headers; the signature covers them. */
  headers: Record<string, string>;
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

  abstract presignDownload(input: {
    bucket: StorageBucket;
    key: string;
    expiresInSec: number;
  }): Promise<string>;

  abstract exists(bucket: StorageBucket, key: string): Promise<boolean>;

  /**
   * Removes one object. Deleting an object that is already gone is a success, so a retry after a crash
   * finishes the job (account deletion and the Aadhaar retention sweep rely on this). Any other failure throws.
   */
  abstract delete(bucket: StorageBucket, key: string): Promise<void>;
}
