import { Module } from '@nestjs/common';
import { firebaseMessagingProvider } from './firebase.provider.js';
import { NotificationsCleanupService } from './notifications-cleanup.service.js';
import { NotificationsController } from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';

@Module({
  controllers: [NotificationsController],
  providers: [
    firebaseMessagingProvider,
    NotificationsService,
    NotificationsCleanupService,
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
