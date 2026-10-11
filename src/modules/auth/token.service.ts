import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AppException } from '../../common/exceptions/app.exception.js';
import type { EnvVars } from '../../config/env.validation.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  /** Access-token lifetime in seconds. */
  expiresIn: number;
}

type Db = Prisma.TransactionClient;

export const sha256Hex = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Access tokens: short-lived HS256 JWT (`sub` = user id). Refresh tokens: opaque 256-bit random
 * strings, stored only as SHA-256, rotated on every use and grouped in a "family" per login so a
 * replayed (stolen) token can revoke the whole login.
 */
@Injectable()
export class TokenService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<EnvVars, true>,
  ) {}

  /** Starts a new login (new family). Pass `tx` to make it part of a larger transaction. */
  async createSession(
    db: Db,
    userId: string,
    familyId: string = randomUUID(),
  ): Promise<TokenPair> {
    const refreshToken = randomBytes(32).toString('base64url');
    const days = this.config.get('REFRESH_TTL_DAYS', { infer: true });
    await db.refreshToken.create({
      data: {
        userId,
        familyId,
        tokenHash: sha256Hex(refreshToken),
        expiresAt: new Date(Date.now() + days * DAY_MS),
      },
    });
    return { ...(await this.signAccess(userId)), refreshToken };
  }

  async signAccess(
    userId: string,
  ): Promise<Pick<TokenPair, 'accessToken' | 'expiresIn'>> {
    const expiresIn = this.config.get('JWT_ACCESS_TTL_SEC', { infer: true });
    const accessToken = await this.jwt.signAsync(
      { sub: userId },
      { algorithm: 'HS256', expiresIn, jwtid: randomUUID() },
    );
    return { accessToken, expiresIn };
  }

  /** Returns the user id, or throws 401 TOKEN_EXPIRED / UNAUTHENTICATED. */
  async verifyAccess(token: string): Promise<string> {
    return (await this.verifyAccessClaims(token)).userId;
  }

  /** Like verifyAccess, plus the moment the token stops being valid (used to end WebSocket sessions). */
  async verifyAccessClaims(
    token: string,
  ): Promise<{ userId: string; expiresAt: Date }> {
    try {
      const payload = await this.jwt.verifyAsync<{
        sub?: unknown;
        exp?: unknown;
      }>(token, { algorithms: ['HS256'] });
      if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
        throw new Error('missing subject');
      }
      if (typeof payload.exp !== 'number') {
        throw new Error('missing expiry');
      }
      return { userId: payload.sub, expiresAt: new Date(payload.exp * 1000) };
    } catch (error) {
      if (error instanceof Error && error.name === 'TokenExpiredError') {
        throw new AppException('TOKEN_EXPIRED', 401, 'Access token expired');
      }
      throw new AppException('UNAUTHENTICATED', 401, 'Invalid access token');
    }
  }

  /**
   * Exchanges a refresh token for a new pair. The old token is spent. Presenting an already-spent
   * token means it was copied, so the whole login (family) is revoked.
   */
  async refresh(rawToken: string): Promise<TokenPair> {
    const row = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: sha256Hex(rawToken) },
    });
    if (!row) {
      throw new AppException(
        'REFRESH_INVALID',
        401,
        'Refresh token is not valid',
      );
    }
    if (row.revokedAt) {
      await this.revokeFamily(row.familyId);
      throw new AppException(
        'REFRESH_REUSED',
        401,
        'This session has ended; please sign in again',
      );
    }
    if (row.expiresAt.getTime() <= Date.now()) {
      throw new AppException(
        'REFRESH_INVALID',
        401,
        'Refresh token has expired',
      );
    }

    const user = await this.prisma.user.findUnique({
      where: { id: row.userId },
      select: { isActive: true },
    });
    if (!user?.isActive) {
      await this.revokeFamily(row.familyId);
      throw new AppException(
        'ACCOUNT_DISABLED',
        403,
        'This account is disabled',
      );
    }

    // Claim + issue atomically. Of two simultaneous refreshes with the same token only one wins.
    const pair = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.refreshToken.updateMany({
        where: { id: row.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return claimed.count === 1
        ? this.createSession(tx, row.userId, row.familyId)
        : null;
    });
    if (!pair) {
      await this.revokeFamily(row.familyId);
      throw new AppException(
        'REFRESH_REUSED',
        401,
        'This session has ended; please sign in again',
      );
    }
    return pair;
  }

  /** Ends the login the token belongs to. Idempotent; ignores tokens that are not the caller's. */
  async logout(userId: string, rawToken: string): Promise<void> {
    const row = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: sha256Hex(rawToken) },
    });
    if (row && row.userId === userId) {
      await this.revokeFamily(row.familyId);
    }
  }

  private async revokeFamily(familyId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}
