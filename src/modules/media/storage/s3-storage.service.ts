import {
  DeleteObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvVars } from '../../../config/env.validation.js';
import type { StorageBucket } from '../media-rules.js';
import { StorageService, type PresignedUpload } from './storage.service.js';

/**
 * S3 (or any S3-compatible service). With no access keys configured the AWS SDK falls back to
 * the instance/task IAM role, which is the recommended setup on AWS.
 */
@Injectable()
export class S3StorageService extends StorageService {
  private readonly client: S3Client;

  constructor(private readonly config: ConfigService<EnvVars, true>) {
    super();
    const accessKeyId = config.get('STORAGE_ACCESS_KEY', { infer: true });
    const secretAccessKey = config.get('STORAGE_SECRET_KEY', { infer: true });
    const endpoint = config.get('STORAGE_ENDPOINT', { infer: true });
    this.client = new S3Client({
      region: config.get('STORAGE_REGION', { infer: true }),
      ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
      ...(accessKeyId && secretAccessKey
        ? { credentials: { accessKeyId, secretAccessKey } }
        : {}),
    });
  }

  async presignUpload(input: {
    bucket: StorageBucket;
    key: string;
    contentType: string;
    sizeBytes: number;
    expiresInSec: number;
  }): Promise<PresignedUpload> {
    const url = await getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucketName(input.bucket),
        Key: input.key,
        ContentType: input.contentType,
        ContentLength: input.sizeBytes,
      }),
      {
        expiresIn: input.expiresInSec,
        // Keep type and size inside the signature, so S3 rejects an upload that differs from
        // what was approved (a different type, or a bigger file).
        unhoistableHeaders: new Set(['content-type', 'content-length']),
        signableHeaders: new Set(['content-type', 'content-length']),
      },
    );
    return {
      url,
      method: 'PUT',
      headers: { 'Content-Type': input.contentType },
    };
  }

  presignDownload(input: {
    bucket: StorageBucket;
    key: string;
    expiresInSec: number;
  }): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucketName(input.bucket),
        Key: input.key,
      }),
      { expiresIn: input.expiresInSec },
    );
  }

  async exists(bucket: StorageBucket, key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucketName(bucket), Key: key }),
      );
      return true;
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } })
        .$metadata?.httpStatusCode;
      if (status === 404 || (error as Error).name === 'NotFound') return false;
      throw error;
    }
  }

  async delete(bucket: StorageBucket, key: string): Promise<void> {
    // S3 answers 204 for a key that does not exist, so a repeated delete is naturally a success
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucketName(bucket), Key: key }),
    );
  }

  private bucketName(bucket: StorageBucket): string {
    return this.config.get(
      bucket === 'private' ? 'STORAGE_BUCKET_PRIVATE' : 'STORAGE_BUCKET',
      { infer: true },
    )!;
  }
}
