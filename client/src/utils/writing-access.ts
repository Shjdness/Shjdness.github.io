import type { Profile } from '../state/profile';
import { accountIdFromToken } from '../data/local-first';

// Local visibility only: the server still verifies the signature, expiry and role.
// Do not mount the editor (which reads local drafts) for a missing/stale identity.
export function writingAccountId(profile: Profile | undefined, token?: string): number | null {
  if (!profile || !Number.isSafeInteger(profile.id) || profile.id <= 0) return null;
  if (accountIdFromToken(token) !== profile.id) return null;
  return profile.canWrite === true || profile.permission === true ? profile.id : null;
}
