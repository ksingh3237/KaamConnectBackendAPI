import { createHash } from 'node:crypto';
import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  InjectThrottlerStorage,
  ThrottlerException,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../decorators/current-user.decorator.js';
import {
  SKIP_USER_THROTTLE_KEY,
  USER_THROTTLE_KEY,
  type UserThrottleOptions,
} from './user-throttle.decorator.js';

/** DI token for the per-user limit, so tests can lower it without touching the environment. */
export const USER_RATE_LIMIT = Symbol('USER_RATE_LIMIT');

export interface UserRateLimit {
  /** Requests one signed-in user may make per window, across ALL routes. */
  limit: number;
  windowMs: number;
}

/**
 * A second, per-USER rate limit that sits behind the existing per-IP one; it never replaces or relaxes it.
 *
 * Why: the per-IP limit stops one address, but an account can change address (mobile data, a VPN, a botnet), and a
 * stolen token can be used from anywhere. This counts what one signed-in account does, whatever address it comes
 * from. It does NOT help users who share an address (the per-IP numbers are unchanged), by design: raising those
 * would loosen a protection and is a separate decision (docs/09 section 1.2, T-1).
 *
 * It runs after the JWT guard (so the user is known) and before ProfileGuard (so a refused request costs no
 * database lookup). Requests with no signed-in user (login, refresh, health) are not its business. The counter lives
 * in the same in-memory store as the per-IP one, so it has the same limits: per process, reset by a restart (T-3).
 */
@Injectable()
export class UserThrottlerGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @InjectThrottlerStorage() private readonly storage: ThrottlerStorage,
    @Inject(USER_RATE_LIMIT) private readonly rate: UserRateLimit,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const http = context.switchToHttp();
    const userId = http.getRequest<AuthenticatedRequest>().user?.id;
    if (!userId) return true;

    const targets = [context.getHandler(), context.getClass()];
    if (
      this.reflector.getAllAndOverride<boolean>(SKIP_USER_THROTTLE_KEY, targets)
    )
      return true;

    const response = http.getResponse<Response>();
    await this.consume(
      response,
      `user-all-${userId}`,
      this.rate.limit,
      this.rate.windowMs,
      'user',
    );

    const route = this.reflector.getAllAndOverride<
      UserThrottleOptions | undefined
    >(USER_THROTTLE_KEY, targets);
    if (route) {
      await this.consume(
        response,
        `user-route-${context.getClass().name}-${context.getHandler().name}-${userId}`,
        route.limit,
        route.ttlMs,
        'user-route',
      );
    }
    return true;
  }

  private async consume(
    response: Response,
    rawKey: string,
    limit: number,
    ttlMs: number,
    name: string,
  ): Promise<void> {
    const key = createHash('sha256').update(rawKey).digest('hex');
    const hit = await this.storage.increment(key, ttlMs, limit, 0, name);
    if (hit.isBlocked) {
      // Same header and same error as the per-IP guard, so clients handle both alike.
      response.setHeader(
        'Retry-After',
        String(Math.max(1, hit.timeToBlockExpire)),
      );
      throw new ThrottlerException();
    }
  }
}
