import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvVars } from '../../config/env.validation.js';
import { SafetyController } from './safety.controller.js';
import {
  LoggingSafetyNotifier,
  SafetyNotifier,
  WebhookSafetyNotifier,
} from './safety-notifier.js';
import { SosService } from './sos.service.js';

/** SOS alerts. The channel is `SOS_WEBHOOK_URL` when set (required in production), otherwise the log. */
@Module({
  controllers: [SafetyController],
  providers: [
    SosService,
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
