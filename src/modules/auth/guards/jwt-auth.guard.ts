import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../../../common/decorators/public.decorator.js';
import type { AuthenticatedRequest } from '../../../common/decorators/current-user.decorator.js';
import { AppException } from '../../../common/exceptions/app.exception.js';
import { TokenService } from '../token.service.js';

/**
 * Global guard: every HTTP route needs `Authorization: Bearer <access token>` unless it is
 * marked @Public(). It checks the signature and expiry only (no database hit); a user disabled
 * mid-session is cut off at the next refresh (access tokens live 15 minutes).
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.headers.authorization;
    const [scheme, token] = header?.split(' ') ?? [];
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      throw new AppException('UNAUTHENTICATED', 401, 'Authentication required');
    }

    request.user = { id: await this.tokens.verifyAccess(token) };
    return true;
  }
}
