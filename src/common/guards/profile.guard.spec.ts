import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { vi } from 'vitest';
import { VerificationStatus } from '../../generated/prisma/enums.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator.js';
import {
  ADMIN_ONLY_KEY,
  REQUIRE_PROFILE_KEY,
  type ProfileRequirement,
} from '../decorators/require-profile.decorator.js';
import { ProfileGuard } from './profile.guard.js';

/**
 * ProfileGuard decides from the DATABASE, on every authenticated request, with ONE lookup made from the user's
 * side: is the account active, is the user an admin, does the required profile exist and is it verified. So a
 * disabled account, a created profile, a removed admin flag or a worker sent back for review (D-8) takes
 * effect on the next call and not when the access token expires. Ownership of a particular record is still
 * checked inside each service (see the IDOR matrix).
 */
describe('ProfileGuard', () => {
  type Meta = {
    profile?: ProfileRequirement;
    admin?: boolean;
    isPublic?: boolean;
  };
  type UserRow = {
    isActive: boolean;
    isAdmin?: boolean;
    customer?: { userId: string } | null;
    worker?: { verificationStatus: VerificationStatus } | null;
  };
  const ACTIVE: UserRow = { isActive: true };

  function build(meta: Meta, user: UserRow | null = ACTIVE) {
    const prisma = { user: { findUnique: vi.fn().mockResolvedValue(user) } };
    const reflector = {
      getAllAndOverride: vi.fn((key: string) =>
        key === REQUIRE_PROFILE_KEY
          ? meta.profile
          : key === ADMIN_ONLY_KEY
            ? meta.admin
            : key === IS_PUBLIC_KEY
              ? meta.isPublic
              : undefined,
      ),
    };
    const guard = new ProfileGuard(
      reflector as unknown as Reflector,
      prisma as unknown as PrismaService,
    );
    const context = (userId: string | undefined, type = 'http') =>
      ({
        getType: () => type,
        getHandler: () => () => undefined,
        getClass: () => class {},
        switchToHttp: () => ({
          getRequest: () => ({ user: userId ? { id: userId } : undefined }),
        }),
      }) as unknown as ExecutionContext;
    return { guard, prisma, context };
  }

  const refused = (promise: Promise<boolean>, status: number, code: string) =>
    expect(promise).rejects.toMatchObject({ status, code });

  describe('what it does not judge', () => {
    it('public routes and anything that is not an HTTP request: no lookup at all', async () => {
      const pub = build({ isPublic: true });
      await expect(pub.guard.canActivate(pub.context('u1'))).resolves.toBe(
        true,
      );
      expect(pub.prisma.user.findUnique).not.toHaveBeenCalled();

      const ws = build({ profile: { role: 'worker' } });
      await expect(ws.guard.canActivate(ws.context('u1', 'ws'))).resolves.toBe(
        true,
      );
      expect(ws.prisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('a route with no requirement and nobody signed in passes (the JWT guard is what refuses such a request)', async () => {
      const { guard, prisma, context } = build({});
      await expect(guard.canActivate(context(undefined))).resolves.toBe(true);
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('a requirement with nobody signed in is 401, before any lookup', async () => {
      for (const meta of [
        { profile: { role: 'customer' as const } },
        { admin: true },
      ]) {
        const { guard, prisma, context } = build(meta);
        await refused(
          guard.canActivate(context(undefined)),
          401,
          'UNAUTHENTICATED',
        );
        expect(prisma.user.findUnique).not.toHaveBeenCalled();
      }
    });
  });

  describe('K-5: a disabled account is refused on every protected route', () => {
    it('a route with NO profile requirement: one lookup of just is_active, then 403 ACCOUNT_DISABLED', async () => {
      const { guard, prisma, context } = build({}, { isActive: false });
      await refused(guard.canActivate(context('u1')), 403, 'ACCOUNT_DISABLED');
      expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: 'u1' },
        select: { isActive: true },
      });
    });

    it('an active user on that same route passes', async () => {
      const { guard, context } = build({});
      await expect(guard.canActivate(context('u1'))).resolves.toBe(true);
    });

    it('a customer route, a worker route and a verified-worker route all answer ACCOUNT_DISABLED, not a profile error, even if the profile exists', async () => {
      const disabledWithProfiles: UserRow = {
        isActive: false,
        customer: { userId: 'u1' },
        worker: { verificationStatus: VerificationStatus.VERIFIED },
      };
      for (const profile of [
        { role: 'customer' as const },
        { role: 'worker' as const },
        { role: 'worker' as const, verified: true },
      ]) {
        const { guard, context } = build({ profile }, disabledWithProfiles);
        await refused(
          guard.canActivate(context('u1')),
          403,
          'ACCOUNT_DISABLED',
        );
      }
    });

    it('a disabled account WITHOUT a profile still gets ACCOUNT_DISABLED, not "complete your profile"', async () => {
      const { guard, context } = build(
        { profile: { role: 'customer' } },
        { isActive: false, customer: null },
      );
      await refused(guard.canActivate(context('u1')), 403, 'ACCOUNT_DISABLED');
    });

    it('a disabled admin still gets 404 on an admin route (the admin API is never advertised)', async () => {
      const { guard, context } = build(
        { admin: true },
        { isActive: false, isAdmin: true },
      );
      await refused(guard.canActivate(context('u1')), 404, 'NOT_FOUND');
    });

    it('a valid token for a user that no longer exists is 401', async () => {
      const { guard, context } = build({}, null);
      await refused(guard.canActivate(context('u1')), 401, 'UNAUTHENTICATED');
    });

    it('the answer is read fresh on every call: disabling takes effect on the next request, re-enabling too', async () => {
      const { guard, prisma, context } = build({});
      prisma.user.findUnique
        .mockResolvedValueOnce({ isActive: true })
        .mockResolvedValueOnce({ isActive: false })
        .mockResolvedValueOnce({ isActive: true });
      await expect(guard.canActivate(context('u1'))).resolves.toBe(true);
      await refused(guard.canActivate(context('u1')), 403, 'ACCOUNT_DISABLED');
      await expect(guard.canActivate(context('u1'))).resolves.toBe(true);
      expect(prisma.user.findUnique).toHaveBeenCalledTimes(3);
    });
  });

  describe('@RequireProfile("customer")', () => {
    it("passes with a customer profile, using ONE lookup by the token's user id that reads only what it needs", async () => {
      const { guard, prisma, context } = build(
        { profile: { role: 'customer' } },
        { isActive: true, customer: { userId: 'u1' } },
      );
      await expect(guard.canActivate(context('u1'))).resolves.toBe(true);
      expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: 'u1' },
        select: { isActive: true, customer: { select: { userId: true } } },
      });
    });

    it('answers 403 CUSTOMER_PROFILE_REQUIRED without one', async () => {
      const { guard, context } = build(
        { profile: { role: 'customer' } },
        { isActive: true, customer: null },
      );
      await refused(
        guard.canActivate(context('u1')),
        403,
        'CUSTOMER_PROFILE_REQUIRED',
      );
    });
  });

  describe('@RequireProfile("worker")', () => {
    const worker = (verificationStatus: VerificationStatus): UserRow => ({
      isActive: true,
      worker: { verificationStatus },
    });

    it('answers 403 WORKER_PROFILE_REQUIRED without a profile', async () => {
      const { guard, context } = build(
        { profile: { role: 'worker' } },
        { isActive: true, worker: null },
      );
      await refused(
        guard.canActivate(context('u1')),
        403,
        'WORKER_PROFILE_REQUIRED',
      );
    });

    it('lets a worker in review use routes that only need a profile (ownership routes), with ONE lookup', async () => {
      for (const status of [
        VerificationStatus.PENDING,
        VerificationStatus.REJECTED,
      ]) {
        const { guard, prisma, context } = build(
          { profile: { role: 'worker' } },
          worker(status),
        );
        await expect(guard.canActivate(context('u1'))).resolves.toBe(true);
        expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
        expect(prisma.user.findUnique).toHaveBeenCalledWith({
          where: { id: 'u1' },
          select: {
            isActive: true,
            worker: { select: { verificationStatus: true } },
          },
        });
      }
    });

    it('with verified: true, refuses PENDING and REJECTED workers as 403 NOT_VERIFIED and lets VERIFIED ones in', async () => {
      for (const status of [
        VerificationStatus.PENDING,
        VerificationStatus.REJECTED,
      ]) {
        const { guard, context } = build(
          { profile: { role: 'worker', verified: true } },
          worker(status),
        );
        await refused(guard.canActivate(context('u1')), 403, 'NOT_VERIFIED');
      }
      const ok = build(
        { profile: { role: 'worker', verified: true } },
        worker(VerificationStatus.VERIFIED),
      );
      await expect(ok.guard.canActivate(ok.context('u1'))).resolves.toBe(true);
    });

    it('reads the status fresh on every call, so a re-review (D-8) takes effect on the very next request', async () => {
      const { guard, prisma, context } = build({
        profile: { role: 'worker', verified: true },
      });
      prisma.user.findUnique
        .mockResolvedValueOnce(worker(VerificationStatus.VERIFIED))
        .mockResolvedValueOnce(worker(VerificationStatus.PENDING));
      await expect(guard.canActivate(context('u1'))).resolves.toBe(true);
      await refused(guard.canActivate(context('u1')), 403, 'NOT_VERIFIED');
      expect(prisma.user.findUnique).toHaveBeenCalledTimes(2);
    });
  });

  describe('@AdminOnly()', () => {
    it('answers 404, not 403, to a user who is not an admin, so the API does not advertise itself', async () => {
      const { guard, context } = build(
        { admin: true },
        { isActive: true, isAdmin: false },
      );
      await refused(guard.canActivate(context('u1')), 404, 'NOT_FOUND');
    });

    it('a valid token for a user that does not exist is 401, even on an admin route (the token is for nobody)', async () => {
      const { guard, context } = build({ admin: true }, null);
      await refused(guard.canActivate(context('u1')), 401, 'UNAUTHENTICATED');
    });

    it('lets an active admin in with ONE lookup reading only the two flags', async () => {
      const { guard, prisma, context } = build(
        { admin: true },
        { isActive: true, isAdmin: true },
      );
      await expect(guard.canActivate(context('u1'))).resolves.toBe(true);
      expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: 'u1' },
        select: { isActive: true, isAdmin: true },
      });
    });

    it('an admin route that also needs a profile is still ONE lookup', async () => {
      const { guard, prisma, context } = build(
        { admin: true, profile: { role: 'customer' } },
        { isActive: true, isAdmin: true, customer: { userId: 'u1' } },
      );
      await expect(guard.canActivate(context('u1'))).resolves.toBe(true);
      expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
    });
  });
});
