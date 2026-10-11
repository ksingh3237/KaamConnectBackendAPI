import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthenticatedRequest } from '../decorators/current-user.decorator.js';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator.js';
import {
  ADMIN_ONLY_KEY,
  REQUIRE_PROFILE_KEY,
  type ProfileRequirement,
} from '../decorators/require-profile.decorator.js';
import { AppException } from '../exceptions/app.exception.js';
import { VerificationStatus } from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';

/**
 * Runs after the JWT guard, on every authenticated HTTP request, and decides from the DATABASE, so a change
 * takes effect on the very next call and not when the access token expires:
 *  - the account must still be active (`ACCOUNT_DISABLED`, 403). The JWT guard only checks the signature and
 *    expiry, so without this a user disabled mid-session could keep working for up to 15 minutes;
 *  - @AdminOnly(): the user must be an active admin;
 *  - @RequireProfile(...): the customer or worker profile must exist, and for `verified` routes the worker
 *    must be VERIFIED.
 *
 * It is ONE primary-key lookup, made from the user's side with the related profile selected only when the
 * route asks for it. Ownership of a particular record is still checked inside each service.
 */
@Injectable()
export class ProfileGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const targets = [context.getHandler(), context.getClass()];

    // Public routes are not about a signed-in user (login must work for an account that is being re-checked).
    if (
      this.reflector.getAllAndOverride<boolean | undefined>(
        IS_PUBLIC_KEY,
        targets,
      )
    )
      return true;

    const requirement = this.reflector.getAllAndOverride<
      ProfileRequirement | undefined
    >(REQUIRE_PROFILE_KEY, targets);
    const adminOnly = this.reflector.getAllAndOverride<boolean | undefined>(
      ADMIN_ONLY_KEY,
      targets,
    );

    const userId = context.switchToHttp().getRequest<AuthenticatedRequest>()
      .user?.id;
    if (!userId) {
      // Nothing to judge. A route that asks for a profile or admin rights needs someone signed in.
      if (requirement || adminOnly)
        throw new AppException(
          'UNAUTHENTICATED',
          401,
          'Authentication required',
        );
      return true;
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        isActive: true,
        ...(adminOnly ? { isAdmin: true } : {}),
        ...(requirement?.role === 'customer'
          ? { customer: { select: { userId: true } } }
          : {}),
        ...(requirement?.role === 'worker'
          ? { worker: { select: { verificationStatus: true } } }
          : {}),
      },
    });
    // A valid token for a user that no longer exists.
    if (!user)
      throw new AppException('UNAUTHENTICATED', 401, 'Authentication required');

    if (adminOnly) {
      // 404, not 403: do not advertise that an admin API exists, not even to a disabled admin.
      if (!user.isActive || !user.isAdmin)
        throw new AppException('NOT_FOUND', 404, 'Not found');
    } else if (!user.isActive) {
      throw new AppException(
        'ACCOUNT_DISABLED',
        403,
        'Your account has been disabled. Please contact support.',
      );
    }

    if (requirement?.role === 'customer' && !user.customer)
      throw new AppException(
        'CUSTOMER_PROFILE_REQUIRED',
        403,
        'Complete your customer profile first',
      );

    if (requirement?.role === 'worker') {
      if (!user.worker)
        throw new AppException(
          'WORKER_PROFILE_REQUIRED',
          403,
          'Complete your worker profile first',
        );
      if (
        requirement.verified &&
        user.worker.verificationStatus !== VerificationStatus.VERIFIED
      ) {
        throw new AppException(
          'NOT_VERIFIED',
          403,
          'Your worker profile is not verified yet',
        );
      }
    }
    return true;
  }
}
