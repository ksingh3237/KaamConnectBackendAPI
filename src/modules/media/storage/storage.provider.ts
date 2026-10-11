import type { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  StorageProvider,
  type EnvVars,
} from '../../../config/env.validation.js';
import { LocalStorageService } from './local-storage.service.js';
import { S3StorageService } from './s3-storage.service.js';
import { StorageService } from './storage.service.js';

/** Chooses local (dev) or S3 from STORAGE_PROVIDER at startup. */
export const storageProvider: Provider = {
  provide: StorageService,
  inject: [ConfigService],
  useFactory: (config: ConfigService<EnvVars, true>): StorageService =>
    config.get('STORAGE_PROVIDER', { infer: true }) === StorageProvider.S3
      ? new S3StorageService(config)
      : new LocalStorageService(config),
};
