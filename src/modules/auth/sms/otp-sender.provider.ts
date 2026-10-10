import type { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SmsProvider, type EnvVars } from '../../../config/env.validation.js';
import { ConsoleOtpSender } from './console-otp-sender.js';
import { OtpSender } from './otp-sender.js';

/** Chooses the sender from SMS_PROVIDER at startup. */
export const otpSenderProvider: Provider = {
  provide: OtpSender,
  inject: [ConfigService],
  useFactory: (config: ConfigService<EnvVars, true>): OtpSender => {
    switch (config.get('SMS_PROVIDER', { infer: true })) {
      case SmsProvider.Console:
        return new ConsoleOtpSender();
      default:
        // MSG91 arrives after DLT registration (D-2). Failing at boot beats silently not sending.
        throw new Error(
          'SMS_PROVIDER=msg91 is not implemented yet. Use SMS_PROVIDER=console outside production.',
        );
    }
  },
};
