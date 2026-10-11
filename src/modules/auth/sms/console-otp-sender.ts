import { Injectable, Logger } from '@nestjs/common';
import type { OtpChannel } from '../../../generated/prisma/enums.js';
import { maskPhone } from '../../../common/utils/phone.js';
import { OtpSender } from './otp-sender.js';

/**
 * Development sender: prints the code to the server console instead of sending an SMS.
 * Config validation refuses SMS_PROVIDER=console in production, so codes can never be logged there.
 */
@Injectable()
export class ConsoleOtpSender extends OtpSender {
  private readonly logger = new Logger('OTP (dev console)');

  send(phone: string, code: string, channel: OtpChannel): Promise<void> {
    this.logger.warn(`Code for ${maskPhone(phone)} via ${channel}: ${code}`);
    return Promise.resolve();
  }
}
