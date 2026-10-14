import type { OtpChannel } from '../../../generated/prisma/enums.js';
import { OtpSender } from './otp-sender.js';

/**
 * Installed when LEGACY_OTP_ENABLED=false. OtpService already refuses before it gets here; this makes sure that even
 * a future code path cannot deliver (or, with the console sender, print) a code while the legacy login is off.
 */
export class DisabledOtpSender extends OtpSender {
  send(_phone: string, _code: string, _channel: OtpChannel): Promise<void> {
    return Promise.reject(new Error('Legacy OTP login is disabled'));
  }
}
