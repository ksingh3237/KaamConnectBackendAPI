import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthenticatedRequest } from '../decorators/current-user.decorator.js';
import {
  ADMIN_ONLY_KEY,
  REQUIRE_PROFILE_KEY,
  type ProfileRequirement,
} from '../decorators/require-profile.decorator.js';
import { AppException } from '../exceptions/app.exception.js';
import { VerificationStatus } from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';

/**
 * Runs after the JWT guard. Enforces @RequireProfile(...) and @AdminOnly() from the database, so a
 * profile created or an admin flag removed takes effect immediately (not after the token expires).
 * Ownership of individual records is still checked inside each service.
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
    const requirement = this.reflector.getAllAndOverride<
      ProfileRequirement | undefined
    >(REQUIRE_PROFILE_KEY, targets);
    const adminOnly = this.reflector.getAllAndOverride<boolean | undefined>(
      ADMIN_ONLY_KEY,
      targets,
    );
    if (!requirement && !adminOnly) return true;

    const userId = context.switchToHttp().getRequest<AuthenticatedRequest>()
      .user?.id;
    if (!userId)
      throw new AppException('UNAUTHENTICATED', 401, 'Authentication required');

    if (adminOnly) {
      const admin = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { isAdmin: true, isActive: true },
      });
      // 404, not 403: do not advertise that an admin API exists.
      if (!admin?.isAdmin || !admin.isActive)
        throw new AppException('NOT_FOUND', 404, 'Not found');
    }

    if (requirement?.role === 'customer') {
      const profile = await this.prisma.customerProfile.findUnique({
        where: { userId },
        select: { userId: true },
      });
      if (!profile)
        throw new AppException(
          'CUSTOMER_PROFILE_REQUIRED',
          403,
          'Complete your customer profile first',
        );
    }

    if (requirement?.role === 'worker') {
      const profile = await this.prisma.workerProfile.findUnique({
        where: { userId },
        select: { verificationStatus: true },
      });
      if (!profile)
        throw new AppException(
          'WORKER_PROFILE_REQUIRED',
          403,
          'Complete your worker profile first',
        );
      if (
        requirement.verified &&
        profile.verificationStatus !== VerificationStatus.VERIFIED
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
