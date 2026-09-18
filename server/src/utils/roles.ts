/**
 * Authorization is deliberately derived from the existing permission column.
 * It keeps the deployed OAuth/user records compatible while giving new Life
 * modules stable role names instead of relying on usernames.
 */
export type Role = 'visitor' | 'member' | 'trusted' | 'owner';

type RoleSubject = {
    permission: number | null;
    accessExpiresAt?: Date | null;
};

export function roleForUser(user?: RoleSubject | null): Role {
    if (!user) return 'visitor';
    if (user.permission === 1) return 'owner';
    if (user.permission === 2) {
        const hasExpired = user.accessExpiresAt && user.accessExpiresAt.getTime() <= Date.now();
        return hasExpired ? 'member' : 'trusted';
    }
    return 'member';
}

export function canAccessLife(role: Role) {
    return role === 'owner' || role === 'trusted';
}
