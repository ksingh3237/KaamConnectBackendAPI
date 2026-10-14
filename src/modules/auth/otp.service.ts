import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppException } from '../../common/exceptions/app.exception.js';
import { maskPhone } from '../../common/utils/phone.js';
import type { EnvVars } from '../../config/env.validation.js';
import { OtpChannel } from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { OtpSender } from './sms/otp-sender.js';

const HOUR_MS = 60 * 60 * 1000;
/** Fixed code used only when OTP_DEV_BYPASS=true (config validation refuses that in production). */
const DEV_BYPASS_CODE = '123456';

export interface OtpRequestResult {
  resendAfterSec: number;
  expiresInSec: number;
  /**
   * PRESENT ONLY WHEN OTP_DEV_BYPASS IS ON (local development; the configuration check refuses that setting in
   * production, so this field cannot appear there). Tells the developer, and lets the app show a banner, that no
   * SMS is sent and which fixed code to type.
   */
  devNotice?: string;
}

/**
 * Phone-number proof of ownership. Guess budget per phone: OTP_MAX_ATTEMPTS tries per code, a new
 * code only every OTP_RESEND_SEC and at most OTP_MAX_REQUESTS_PER_HOUR per hour, i.e. 25 guesses per
 * hour against a 1-in-1,000,000 code. Per-IP throttling sits on top (see AuthController).
 */
@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sender: OtpSender,
    private readonly config: ConfigService<EnvVars, true>,
  ) {}

  /** LEGACY_OTP_ENABLED=false switches the SMS-code login off everywhere it is used (login and account deletion). */
  private assertEnabled(): void {
    if (!this.config.get('LEGACY_OTP_ENABLED', { infer: true })) {
      throw new AppException(
        'LEGACY_OTP_DISABLED',
        404,
        'SMS-code sign-in is not available; use phone verification in the app',
      );
    }
  }

  async request(phone: string, channel: OtpChannel): Promise<OtpRequestResult> {
    this.assertEnabled();
    if (channel === OtpChannel.WHATSAPP) {
      throw new AppException(
        'CHANNEL_NOT_AVAILABLE',
        501,
        'WhatsApp OTP is not available yet',
      );
    }

    const resendAfterSec = this.config.get('OTP_RESEND_SEC', { infer: true });
    const expiresInSec = this.config.get('OTP_TTL_SEC', { infer: true });
    const maxPerHour = this.config.get('OTP_MAX_REQUESTS_PER_HOUR', {
      infer: true,
    });
    const code = this.config.get('OTP_DEV_BYPASS', { infer: true })
      ? DEV_BYPASS_CODE
      : generateCode();

    const challenge = await this.prisma.$transaction(async (tx) => {
      // One request per phone at a time, so two simultaneous taps cannot both pass the cooldown.
      // ($executeRaw: the function returns `void`, which $queryRaw cannot deserialise.)
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${phone}))`;

      const now = Date.now();
      const recent = await tx.otpChallenge.findMany({
        where: { phone, createdAt: { gt: new Date(now - HOUR_MS) } },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });

      const latest = recent[0];
      if (latest) {
        const waitMs = latest.createdAt.getTime() + resendAfterSec * 1000 - now;
        if (waitMs > 0) {
          throw new AppException(
            'OTP_COOLDOWN',
            429,
            'Please wait before requesting another code',
            undefined,
            Math.ceil(waitMs / 1000),
          );
        }
      }
      if (recent.length >= maxPerHour) {
        const oldest = recent[recent.length - 1]!;
        throw new AppException(
          'OTP_LIMIT',
          429,
          'Too many codes requested; try again later',
          undefined,
          Math.max(
            1,
            Math.ceil((oldest.createdAt.getTime() + HOUR_MS - now) / 1000),
          ),
        );
      }

      // A new code replaces any earlier one that is still usable.
      await tx.otpChallenge.updateMany({
        where: { phone, consumedAt: null, expiresAt: { gt: new Date(now) } },
        data: { consumedAt: new Date(now) },
      });
      return tx.otpChallenge.create({
        data: {
          phone,
          channel,
          codeHash: this.hash(phone, code),
          expiresAt: new Date(now + expiresInSec * 1000),
        },
      });
    });

    try {
      await this.sender.send(phone, code, channel);
    } catch (error) {
      // Nobody received this code, so retire it and do not count the failure against the user.
      await this.prisma.otpChallenge.delete({ where: { id: challenge.id } });
      this.logger.error(
        `OTP delivery to ${maskPhone(phone)} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new AppException(
        'OTP_SEND_FAILED',
        502,
        'Could not send the code; please try again',
      );
    }

    const bypass = this.config.get('OTP_DEV_BYPASS', { infer: true });
    return {
      resendAfterSec,
      expiresInSec,
      ...(bypass
        ? {
            devNotice: `DEVELOPMENT ONLY: no SMS is sent. The code is ${DEV_BYPASS_CODE} for every number.`,
          }
        : {}),
    };
  }

  /**
   * Checks a code against the newest unused, unexpired challenge. Returns the challenge id so the
   * caller can consume it in the same transaction that creates the session.
   * Every failure for "no such code / wrong / expired / already used" is the same OTP_INVALID.
   */
  async check(phone: string, code: string): Promise<string> {
    this.assertEnabled();
    const maxAttempts = this.config.get('OTP_MAX_ATTEMPTS', { infer: true });

    const challenge = await this.prisma.otpChallenge.findFirst({
      where: { phone, consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (!challenge) throw invalid();

    // Spend an attempt BEFORE comparing. Parallel guesses therefore cannot exceed the budget.
    const spent = await this.prisma.otpChallenge.updateMany({
      where: {
        id: challenge.id,
        consumedAt: null,
        attempts: { lt: maxAttempts },
      },
      data: { attempts: { increment: 1 } },
    });
    if (spent.count === 0) {
      // Either the attempts are used up, or a concurrent request just spent this code. Say which:
      // telling someone with the right code that they were "locked out" would be misleading.
      const current = await this.prisma.otpChallenge.findUnique({
        where: { id: challenge.id },
        select: { consumedAt: true },
      });
      throw current && current.consumedAt === null ? locked() : invalid();
    }

    if (!this.matches(phone, code, challenge.codeHash)) {
      if (challenge.attempts + 1 >= maxAttempts) throw locked();
      throw invalid();
    }
    return challenge.id;
  }

  private hash(phone: string, code: string): string {
    return createHmac('sha256', this.config.get('OTP_PEPPER', { infer: true }))
      .update(`${phone}:${code}`)
      .digest('hex');
  }

  private matches(phone: string, code: string, expectedHash: string): boolean {
    const actual = Buffer.from(this.hash(phone, code), 'hex');
    const expected = Buffer.from(expectedHash, 'hex');
    return (
      actual.length === expected.length && timingSafeEqual(actual, expected)
    );
  }
}

/** Uniform 6-digit code from the OS CSPRNG (never Math.random). */
export function generateCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

const invalid = () =>
  new AppException('OTP_INVALID', 401, 'The code is incorrect or has expired');
const locked = () =>
  new AppException(
    'OTP_LOCKED',
    429,
    'Too many wrong attempts; request a new code',
    undefined,
    30,
  );
