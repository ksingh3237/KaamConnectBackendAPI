import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvVars } from '../../config/env.validation.js';
import { SafetyController } from './safety.controller.js';
import {
  LoggingSafetyNotifier,
  SafetyNotifier,
  WebhookSafetyNotifier,
} from './safety-notifier.js';
import { SosAdminController } from './sos-admin.controller.js';
import { SosAdminService } from './sos-admin.service.js';
import { SosDeliveryService } from './sos-delivery.service.js';
import { SosService } from './sos.service.js';

/**
 * SOS alerts. The channel is `SOS_WEBHOOK_URL` when set (required in production), otherwise the log. Alerts are
 * stored first, delivered with retries (SosDeliveryService) and closed by the safety desk (SosAdminService).
 */
@Module({
  controllers: [SafetyController, SosAdminController],
  providers: [
    SosService,
    SosDeliveryService,
    SosAdminService,
    {
      provide: SafetyNotifier,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvVars, true>): SafetyNotifier => {
        const url = config.get('SOS_WEBHOOK_URL', { infer: true });
        return url
          ? new WebhookSafetyNotifier(url)
          : new LoggingSafetyNotifier();
      },
    },
  ],
})
export class SafetyModule {}
