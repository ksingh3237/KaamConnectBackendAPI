import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Housekeeping so the OTP and session tables stay small. Safe to run on several instances. */
@Injectable()
export class AuthCleanupService {
  private readonly logger = new Logger(AuthCleanupService.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_HOUR)
  async scheduledPurge(): Promise<void> {
    try {
      const result = await this.purge();
      this.logger.log(
        `Purged ${result.otpChallenges} OTP challenges, ${result.refreshTokens} refresh tokens`,
      );
    } catch (error) {
      this.logger.error(
        `Purge failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** OTP rows older than 24 h; refresh tokens expired or revoked more than 30 days ago. */
  async purge(
    now: Date = new Date(),
  ): Promise<{ otpChallenges: number; refreshTokens: number }> {
    const otpCutoff = new Date(now.getTime() - DAY_MS);
    const tokenCutoff = new Date(now.getTime() - 30 * DAY_MS);

    const [otp, tokens] = await Promise.all([
      this.prisma.otpChallenge.deleteMany({
        where: { createdAt: { lt: otpCutoff } },
      }),
      this.prisma.refreshToken.deleteMany({
        where: {
          OR: [
            { expiresAt: { lt: tokenCutoff } },
            { revokedAt: { lt: tokenCutoff } },
          ],
        },
      }),
    ]);
    return { otpChallenges: otp.count, refreshTokens: tokens.count };
  }
}
