import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/exceptions/app.exception.js';
import {
  ADMIN_READ_URL_TTL_SEC,
  MEDIA_RULES,
  READ_URL_TTL_SEC,
  UPLOAD_URL_TTL_SEC,
  buildKey,
  ownedKeyPattern,
  type MediaPurpose,
} from './media-rules.js';
import { StorageService } from './storage/storage.service.js';

export interface PresignResult {
  uploadUrl: string;
  method: 'PUT';
  /** Send exactly these headers with the PUT. */
  headers: Record<string, string>;
  /** Store this in the profile / job once the upload has succeeded. */
  key: string;
  expiresInSec: number;
}

const invalid = (field: string, issue: string) =>
  new AppException('VALIDATION_FAILED', 422, 'Request validation failed', [
    { field, issue },
  ]);

@Injectable()
export class MediaService {
  constructor(private readonly storage: StorageService) {}

  async presign(
    userId: string,
    input: { purpose: MediaPurpose; contentType: string; sizeBytes: number },
  ): Promise<PresignResult> {
    const rule = MEDIA_RULES[input.purpose];
    if (!rule.allowedTypes.includes(input.contentType)) {
      throw invalid(
        'contentType',
        `${input.purpose} accepts only ${rule.allowedTypes.join(', ')}`,
      );
    }
    if (input.sizeBytes > rule.maxBytes) {
      throw invalid(
        'sizeBytes',
        `${input.purpose} files may be at most ${rule.maxBytes} bytes`,
      );
    }

    const key = buildKey(userId, input.purpose, input.contentType);
    const upload = await this.storage.presignUpload({
      bucket: rule.bucket,
      key,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      expiresInSec: UPLOAD_URL_TTL_SEC,
    });
    return {
      uploadUrl: upload.url,
      method: upload.method,
      headers: upload.headers,
      key,
      expiresInSec: UPLOAD_URL_TTL_SEC,
    };
  }

  /**
   * A key sent by a client is trusted only if this user generated it for this purpose AND the file
   * is really in storage. Otherwise a user could attach someone else's photo or a file never uploaded.
   */
  async assertOwnedUpload(
    userId: string,
    purpose: MediaPurpose,
    key: string,
    field: string,
  ): Promise<void> {
    if (!ownedKeyPattern(userId, purpose).test(key)) {
      throw invalid(
        field,
        `not a valid ${purpose} upload key for this account`,
      );
    }
    if (!(await this.storage.exists(MEDIA_RULES[purpose].bucket, key))) {
      throw invalid(field, 'the file has not been uploaded');
    }
  }

  /** Short-lived read URL for ordinary media. Null stays null so callers can map optional keys. */
  async readUrl(
    purpose: MediaPurpose,
    key: string | null | undefined,
  ): Promise<string | null> {
    if (!key) return null;
    return this.storage.presignDownload({
      bucket: MEDIA_RULES[purpose].bucket,
      key,
      expiresInSec: READ_URL_TTL_SEC,
    });
  }

  /** Admin-only, shorter-lived link to an Aadhaar image in the private bucket. */
  adminAadhaarUrl(key: string): Promise<string> {
    return this.storage.presignDownload({
      bucket: MEDIA_RULES.AADHAAR.bucket,
      key,
      expiresInSec: ADMIN_READ_URL_TTL_SEC,
    });
  }
}
