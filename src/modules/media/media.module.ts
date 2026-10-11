import { Module } from '@nestjs/common';
import { MediaController } from './media.controller.js';
import { MediaService } from './media.service.js';
import { DevStorageController } from './storage/dev-storage.controller.js';
import { storageProvider } from './storage/storage.provider.js';
import { StorageService } from './storage/storage.service.js';

@Module({
  controllers: [MediaController, DevStorageController],
  providers: [MediaService, storageProvider],
  exports: [MediaService, StorageService],
})
export class MediaModule {}
