import type { ConfigService } from '@nestjs/config';
import type { EnvVars } from '../../../config/env.validation.js';
import { OtpChannel } from '../../../generated/prisma/enums.js';
import { ConsoleOtpSender } from './console-otp-sender.js';
import { DisabledOtpSender } from './disabled-otp-sender.js';
import { otpSenderProvider } from './otp-sender.provider.js';

type Factory = (c: ConfigService<EnvVars, true>) => unknown;
const build = (settings: Record<string, unknown>) =>
  (otpSenderProvider as { useFactory: Factory }).useFactory({
    get: (key: string) => settings[key],
  } as ConfigService<EnvVars, true>);

describe('otpSenderProvider', () => {
  it('uses the console sender for the legacy login in development (unchanged)', () => {
    expect(
      build({ LEGACY_OTP_ENABLED: true, SMS_PROVIDER: 'console' }),
    ).toBeInstanceOf(ConsoleOtpSender);
  });

  it('still refuses msg91 while it is not implemented and the legacy login is on', () => {
    expect(() =>
      build({ LEGACY_OTP_ENABLED: true, SMS_PROVIDER: 'msg91' }),
    ).toThrow(/not implemented/);
  });

  it('with the legacy login off installs a sender that can never deliver or print a code, whatever SMS_PROVIDER says', async () => {
    for (const SMS_PROVIDER of ['console', 'msg91']) {
      const sender = build({ LEGACY_OTP_ENABLED: false, SMS_PROVIDER });
      expect(sender).toBeInstanceOf(DisabledOtpSender);
      await expect(
        (sender as DisabledOtpSender).send(
          '+919876543210',
          '123456',
          OtpChannel.SMS,
        ),
      ).rejects.toThrow(/disabled/);
    }
  });
});
