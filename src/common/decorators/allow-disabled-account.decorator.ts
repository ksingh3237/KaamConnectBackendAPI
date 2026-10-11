import { SetMetadata } from '@nestjs/common';

export const ALLOW_DISABLED_ACCOUNT_KEY = 'allowDisabledAccount';

/**
 * Lets a signed-in user whose account is disabled (`users.is_active = false`) call this one route instead of
 * getting `403 ACCOUNT_DISABLED` from ProfileGuard (K-37). It exists for `POST /auth/logout`: a user must be
 * able to end a session, and revoke its refresh tokens, even while disabled.
 *
 * It only skips that one refusal. A valid access token is still required, and it has no effect on a route that
 * also asks for a profile or admin rights (those stay refused for a disabled account). Use it on nothing that
 * reads or changes data other than ending the caller's own session; a test lists the routes that carry it.
 */
export const AllowDisabledAccount = () =>
  SetMetadata(ALLOW_DISABLED_ACCOUNT_KEY, true);
