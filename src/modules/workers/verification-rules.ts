import { VerificationStatus } from '../../generated/prisma/enums.js';

/**
 * Two spellings of a name that differ only in case or spacing are the same name (decision D-8): trimmed,
 * runs of whitespace collapsed to one space, lower-cased. A save that re-sends the stored name never
 * triggers a review.
 */
export function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

export interface StoredIdentity {
  verificationStatus: VerificationStatus;
  fullName: string;
  photoKey: string | null;
}

/** What the worker is asking to save. `undefined` means "leave as is" (PATCH); `null` photo means "remove it". */
export interface RequestedIdentity {
  fullName?: string;
  photoKey?: string | null;
}

/**
 * What saving a profile does to its verification state (decisions D-8 and Q-22).
 *
 * - REJECTED: any edit counts as asking for another review (the worker is fixing what was wrong).
 * - VERIFIED: only a change to what customers rely on to recognise the person sends it back to PENDING:
 *   a different name (compared in normalised form) or a different photo. Re-sending the same name or the
 *   same `photoKey`, changing anything else, or removing the photo (no face is left to impersonate) does not.
 *   `verifiedAt` is cleared with it, like replacing an Aadhaar image does.
 * - PENDING, or no profile yet: nothing to do.
 *
 * In `auto` (development) mode the caller re-approves right afterwards when both documents exist, so
 * development behaves like production.
 */
export function reviewEffect(
  stored: StoredIdentity | null | undefined,
  next: RequestedIdentity,
):
  | Record<string, never>
  | {
      verificationStatus: typeof VerificationStatus.PENDING;
      rejectionReason: null;
      verifiedAt?: null;
    } {
  if (!stored) return {};
  if (stored.verificationStatus === VerificationStatus.REJECTED) {
    return {
      verificationStatus: VerificationStatus.PENDING,
      rejectionReason: null,
    };
  }
  if (stored.verificationStatus !== VerificationStatus.VERIFIED) return {};

  const nameChanged =
    next.fullName !== undefined &&
    normalizeName(next.fullName) !== normalizeName(stored.fullName);
  const photoChanged =
    typeof next.photoKey === 'string' && next.photoKey !== stored.photoKey;
  if (!nameChanged && !photoChanged) return {};
  return {
    verificationStatus: VerificationStatus.PENDING,
    rejectionReason: null,
    verifiedAt: null,
  };
}
