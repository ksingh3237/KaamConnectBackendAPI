import { SetMetadata } from '@nestjs/common';

export const REQUIRE_PROFILE_KEY = 'requireProfile';
export const ADMIN_ONLY_KEY = 'adminOnly';

export interface ProfileRequirement {
  role: 'customer' | 'worker';
  /** Worker only: must be admin-verified (or auto-verified in dev). */
  verified?: boolean;
}

/**
 * The route needs the caller to have this profile. A user may hold both profiles, so the active
 * "mode" is never trusted from the client: each route states the profile it acts as.
 */
export const RequireProfile = (
  role: ProfileRequirement['role'],
  options: { verified?: boolean } = {},
) =>
  SetMetadata(REQUIRE_PROFILE_KEY, {
    role,
    ...options,
  } satisfies ProfileRequirement);

/** Only users flagged `is_admin` may call this route; everyone else gets a plain 404. */
export const AdminOnly = () => SetMetadata(ADMIN_ONLY_KEY, true);
