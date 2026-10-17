import { Module } from '@nestjs/common';
import { firebaseMessagingProvider } from './firebase.provider.js';
import { NotificationsController } from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';

@Module({
  controllers: [NotificationsController],
  providers: [firebaseMessagingProvider, NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
