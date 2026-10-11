import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/exceptions/app.exception.js';
import type { OtpChannel } from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { OtpService, type OtpRequestResult } from './otp.service.js';
import { TokenService, type TokenPair } from './token.service.js';

export interface SessionUser {
  id: string;
  phone: string;
  language: string;
  hasCustomerProfile: boolean;
  hasWorkerProfile: boolean;
}

export interface VerifyResult extends TokenPair {
  /** True only when this verification created the account. */
  isNewUser: boolean;
  user: SessionUser;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly otp: OtpService,
    private readonly tokens: TokenService,
  ) {}

  requestOtp(phone: string, channel: OtpChannel): Promise<OtpRequestResult> {
    return this.otp.request(phone, channel);
  }

  /**
   * Proves phone ownership, then (in one transaction) spends the code, finds or creates the user
   * and starts a session. Either all of that happens or none of it does.
   */
  async verifyOtp(phone: string, code: string): Promise<VerifyResult> {
    const challengeId = await this.otp.check(phone, code);

    return this.prisma.$transaction(async (tx) => {
      const spent = await tx.otpChallenge.updateMany({
        where: { id: challengeId, consumedAt: null },
        data: { consumedAt: new Date() },
      });
      if (spent.count !== 1) {
        // Another request with the same correct code won the race.
        throw new AppException(
          'OTP_INVALID',
          401,
          'The code is incorrect or has expired',
        );
      }

      const existed =
        (await tx.user.findUnique({
          where: { phone },
          select: { id: true },
        })) !== null;
      const user = await tx.user.upsert({
        where: { phone },
        create: { phone },
        update: {},
        include: {
          customer: { select: { userId: true } },
          worker: { select: { userId: true } },
        },
      });
      if (!user.isActive) {
        throw new AppException(
          'ACCOUNT_DISABLED',
          403,
          'This account is disabled',
        );
      }

      const tokens = await this.tokens.createSession(tx, user.id);
      return {
        ...tokens,
        isNewUser: !existed,
        user: {
          id: user.id,
          phone: user.phone,
          language: user.language,
          hasCustomerProfile: user.customer !== null,
          hasWorkerProfile: user.worker !== null,
        },
      };
    });
  }

  refresh(refreshToken: string): Promise<TokenPair> {
    return this.tokens.refresh(refreshToken);
  }

  logout(userId: string, refreshToken: string): Promise<void> {
    return this.tokens.logout(userId, refreshToken);
  }
}
