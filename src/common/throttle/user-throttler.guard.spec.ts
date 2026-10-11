import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { ThrottlerException, ThrottlerStorageService } from '@nestjs/throttler';
import { vi } from 'vitest';
import {
  SKIP_USER_THROTTLE_KEY,
  USER_THROTTLE_KEY,
  type UserThrottleOptions,
} from './user-throttle.decorator.js';
import { UserThrottlerGuard } from './user-throttler.guard.js';

describe('UserThrottlerGuard', () => {
  class SomeController {}
  const handler = function listThings() {};

  function build(
    rate = { limit: 3, windowMs: 60_000 },
    meta: { skip?: boolean; route?: UserThrottleOptions } = {},
  ) {
    const storage = new ThrottlerStorageService();
    const increment = vi.spyOn(storage, 'increment');
    const reflector = {
      getAllAndOverride: vi.fn((key: string) =>
        key === SKIP_USER_THROTTLE_KEY
          ? meta.skip
          : key === USER_THROTTLE_KEY
            ? meta.route
            : undefined,
      ),
    };
    const guard = new UserThrottlerGuard(
      reflector as unknown as Reflector,
      storage,
      rate,
    );
    const setHeader = vi.fn();
    const context = (userId: string | undefined, type = 'http') =>
      ({
        getType: () => type,
        getHandler: () => handler,
        getClass: () => SomeController,
        switchToHttp: () => ({
          getRequest: () => ({ user: userId ? { id: userId } : undefined }),
          getResponse: () => ({ setHeader }),
        }),
      }) as unknown as ExecutionContext;
    return { guard, increment, setHeader, context, storage };
  }

  const hit = async (
    guard: UserThrottlerGuard,
    ctx: ExecutionContext,
    times: number,
  ) => {
    for (let i = 0; i < times; i += 1) await guard.canActivate(ctx);
  };

  it('lets a user make exactly the limit, then refuses with the same error and a Retry-After header as the per-IP guard', async () => {
    const { guard, context, setHeader } = build({ limit: 3, windowMs: 60_000 });
    await hit(guard, context('u1'), 3);
    await expect(guard.canActivate(context('u1'))).rejects.toBeInstanceOf(
      ThrottlerException,
    );
    expect(setHeader).toHaveBeenCalledTimes(1);
    const [name, seconds] = setHeader.mock.calls[0]!;
    expect(name).toBe('Retry-After');
    expect(Number(seconds)).toBeGreaterThanOrEqual(1);
    expect(Number(seconds)).toBeLessThanOrEqual(60);
  });

  it('counts each user separately, whatever else they share', async () => {
    const { guard, context } = build({ limit: 2, windowMs: 60_000 });
    await hit(guard, context('u1'), 2);
    await expect(guard.canActivate(context('u1'))).rejects.toBeInstanceOf(
      ThrottlerException,
    );
    await expect(guard.canActivate(context('u2'))).resolves.toBe(true);
    await expect(guard.canActivate(context('u2'))).resolves.toBe(true);
  });

  it('is not its business when nobody is signed in, or the request is not HTTP: nothing is counted', async () => {
    const { guard, context, increment } = build();
    await hit(guard, context(undefined), 50);
    await expect(guard.canActivate(context('u1', 'ws'))).resolves.toBe(true);
    expect(increment).not.toHaveBeenCalled();
  });

  it('a route marked @SkipUserThrottle() is never counted or refused', async () => {
    const { guard, context, increment } = build(
      { limit: 1, windowMs: 60_000 },
      { skip: true },
    );
    await hit(guard, context('u1'), 20);
    expect(increment).not.toHaveBeenCalled();
  });

  it('after the window the user starts again', async () => {
    const { guard, context } = build({ limit: 1, windowMs: 80 });
    await guard.canActivate(context('u1'));
    await expect(guard.canActivate(context('u1'))).rejects.toBeInstanceOf(
      ThrottlerException,
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    await expect(guard.canActivate(context('u1'))).resolves.toBe(true);
  });

  describe('@UserThrottle(): a tighter limit on one route, in addition to the all-routes limit', () => {
    it('the route limit refuses first, and the all-routes counter still counts those calls', async () => {
      const { guard, context, increment } = build(
        { limit: 100, windowMs: 60_000 },
        { route: { limit: 2, ttlMs: 60_000 } },
      );
      await hit(guard, context('u1'), 2);
      await expect(guard.canActivate(context('u1'))).rejects.toBeInstanceOf(
        ThrottlerException,
      );
      const names = increment.mock.calls.map((c) => c[4]);
      expect(names).toEqual([
        'user',
        'user-route',
        'user',
        'user-route',
        'user',
        'user-route',
      ]);
    });

    it('the all-routes limit still applies on a route that has its own, looser limit', async () => {
      const { guard, context } = build(
        { limit: 2, windowMs: 60_000 },
        { route: { limit: 100, ttlMs: 60_000 } },
      );
      await hit(guard, context('u1'), 2);
      await expect(guard.canActivate(context('u1'))).rejects.toBeInstanceOf(
        ThrottlerException,
      );
    });
  });

  it('keys never contain the user id in the clear (the store holds only hashes)', async () => {
    const { guard, context, increment } = build();
    await guard.canActivate(context('0197a0c0-1111-7000-8000-000000000001'));
    for (const call of increment.mock.calls)
      expect(call[0]).toMatch(/^[0-9a-f]{64}$/);
  });
});
