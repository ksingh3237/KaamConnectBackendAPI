import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppException } from '../../common/exceptions/app.exception.js';
import type { EnvVars } from '../../config/env.validation.js';
import type { OtpChannel } from '../../generated/prisma/enums.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { Msg91TokenVerifier } from './msg91/msg91-token-verifier.js';
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
    private readonly msg91: Msg91TokenVerifier,
    private readonly config: ConfigService<EnvVars, true>,
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

      return this.startSession(tx, phone);
    });
  }

  /**
   * MSG91 OTP widget sign-in. The app proves the number to MSG91 and hands us the resulting access token; we ask
   * MSG91 (with the server-held Authkey) whether it is genuine and which number it belongs to. The number comes
   * only from MSG91's answer, never from the app.
   */
  async msg91SignIn(accessToken: string): Promise<VerifyResult> {
    if (!this.config.get('MSG91_WIDGET_ENABLED', { infer: true })) {
      throw new AppException('NOT_FOUND', 404, 'Not found');
    }
    const phone = await this.msg91.verify(accessToken);
    return this.prisma.$transaction((tx) => this.startSession(tx, phone));
  }

  /** Finds or creates the user for a proven phone number and starts a session. Shared by every sign-in door. */
  private async startSession(
    tx: Prisma.TransactionClient,
    phone: string,
  ): Promise<VerifyResult> {
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
  }

  refresh(refreshToken: string): Promise<TokenPair> {
    return this.tokens.refresh(refreshToken);
  }

  logout(userId: string, refreshToken: string): Promise<void> {
    return this.tokens.logout(userId, refreshToken);
  }
}
