import type { OtpChannel } from '../../../generated/prisma/enums.js';

/**
 * How an OTP reaches the user. An abstract class (not an interface) so it can be the DI token.
 * Dev: ConsoleOtpSender. Production: MSG91 once DLT registration is done (decision D-2).
 */
export abstract class OtpSender {
  abstract send(
    phone: string,
    code: string,
    channel: OtpChannel,
  ): Promise<void>;
}
