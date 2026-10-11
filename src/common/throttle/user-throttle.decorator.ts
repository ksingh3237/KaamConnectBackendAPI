import { SetMetadata } from '@nestjs/common';

export const SKIP_USER_THROTTLE_KEY = 'skipUserThrottle';
export const USER_THROTTLE_KEY = 'userThrottle';

/**
 * Exempts a route from the per-user limit (UserThrottlerGuard). Use it only where being slowed down could cost
 * more than the abuse it prevents. Today that is the SOS route: an emergency call must be the last thing refused.
 * The per-IP limit still applies, exactly as before.
 */
export const SkipUserThrottle = () => SetMetadata(SKIP_USER_THROTTLE_KEY, true);

export interface UserThrottleOptions {
  /** Requests allowed per user in `ttlMs` on this route, in addition to the all-routes limit. */
  limit: number;
  ttlMs: number;
}

/**
 * A tighter per-user limit for one expensive route, in addition to the all-routes per-user limit. The mechanism
 * is built and tested; NO route uses it yet (a limit on real users is a decision, see docs/09 section 1.4).
 */
export const UserThrottle = (options: UserThrottleOptions) =>
  SetMetadata(USER_THROTTLE_KEY, options);
