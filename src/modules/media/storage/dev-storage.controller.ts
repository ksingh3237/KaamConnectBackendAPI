import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  Controller,
  Get,
  HttpCode,
  Param,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '../../../common/decorators/public.decorator.js';
import { AppException } from '../../../common/exceptions/app.exception.js';
import {
  ANY_KEY_PATTERN,
  CONTENT_TYPE_BY_EXTENSION,
  type StorageBucket,
} from '../media-rules.js';
import {
  DEV_STORAGE_ROUTE,
  LocalStorageService,
} from './local-storage.service.js';
import { StorageService } from './storage.service.js';

const notFound = () => new AppException('NOT_FOUND', 404, 'Not found');

/**
 * Receives and serves files for LocalStorageService (development only). Authorisation is the
 * signed URL itself, exactly like S3. With STORAGE_PROVIDER=s3 every request here is a 404.
 */
@Public()
@Controller(DEV_STORAGE_ROUTE)
export class DevStorageController {
  constructor(private readonly storage: StorageService) {}

  @Put(':bucket/*key')
  @HttpCode(200)
  async upload(
    @Param('bucket') bucket: string,
    @Param('key') keyParts: string | string[],
    @Query() query: Record<string, string | undefined>,
    @Req() req: Request,
  ): Promise<{ ok: true }> {
    const local = this.local();
    const key = joinKey(keyParts);
    const exp = Number(query.exp);
    const contentType = query.ct ?? '';
    const declaredLength = Number(query.len);

    if (
      !local.verify(
        ['PUT', bucket, key, exp, contentType, declaredLength],
        query.sig ?? '',
        exp,
      )
    ) {
      throw new AppException(
        'FORBIDDEN',
        403,
        'Upload link is invalid or has expired',
      );
    }
    // S3 enforces both of these through the signature; mirror that here.
    if (req.headers['content-type'] !== contentType) {
      throw new AppException(
        'FORBIDDEN',
        403,
        'Content-Type does not match the upload link',
      );
    }
    if (Number(req.headers['content-length']) !== declaredLength) {
      throw new AppException(
        'FORBIDDEN',
        403,
        'Content-Length does not match the upload link',
      );
    }

    const target = local.filePath(bucket as StorageBucket, key);
    const temp = `${target}.${process.pid}.part`;
    await fs.mkdir(path.dirname(target), { recursive: true });

    let received = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        received += chunk.length;
        done(received > declaredLength ? new Error('too large') : null, chunk);
      },
    });
    try {
      await pipeline(req, counter, createWriteStream(temp));
      if (received !== declaredLength) throw new Error('incomplete');
      await fs.rename(temp, target);
    } catch {
      await fs.rm(temp, { force: true });
      throw new AppException(
        'BAD_REQUEST',
        400,
        'Upload did not match the declared size',
      );
    }
    return { ok: true };
  }

  @Get(':bucket/*key')
  async download(
    @Param('bucket') bucket: string,
    @Param('key') keyParts: string | string[],
    @Query() query: Record<string, string | undefined>,
    @Res() res: Response,
  ): Promise<void> {
    const local = this.local();
    const key = joinKey(keyParts);
    const exp = Number(query.exp);

    if (!local.verify(['GET', bucket, key, exp], query.sig ?? '', exp)) {
      throw new AppException(
        'FORBIDDEN',
        403,
        'Download link is invalid or has expired',
      );
    }
    const file = local.filePath(bucket as StorageBucket, key);
    if (!(await local.exists(bucket as StorageBucket, key))) throw notFound();

    res.setHeader(
      'Content-Type',
      CONTENT_TYPE_BY_EXTENSION[path.extname(key).slice(1)] ??
        'application/octet-stream',
    );
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    await pipeline(createReadStream(file), res);
  }

  /** 404 unless the local provider is the active one. */
  private local(): LocalStorageService {
    if (!(this.storage instanceof LocalStorageService)) throw notFound();
    return this.storage;
  }
}

/** Express 5 returns a wildcard as an array of segments. Reject anything that is not our key shape. */
function joinKey(parts: string | string[]): string {
  const key = Array.isArray(parts) ? parts.join('/') : parts;
  if (!ANY_KEY_PATTERN.test(key)) throw notFound();
  return key;
}
